#!/usr/bin/env node
// telegram-delegate router: owns the bot (long polling), routes guests to sessions, serves the localhost API.
import { basename, join } from 'node:path'
import { Bot, GrammyError } from 'grammy'
import { ensureApiToken, loadConfig } from '../config.ts'
import { RouteStore } from '../routes.ts'
import { createApi } from './api.ts'
import { Hub } from './hub.ts'
import { checkIdle } from './idle.ts'
import { createMedia } from './media.ts'
import { createTelegram, type BotLike } from './telegram.ts'

const IDLE_CHECK_MS = 10 * 60_000

function log(msg: string): void {
  process.stderr.write(`telegram-delegate: ${msg}\n`)
}

const cfg = loadConfig()
if (!cfg.botToken) {
  log('TELEGRAM_BOT_TOKEN не задан в ~/.config/telegram-delegate/.env')
  process.exit(1)
}
const botToken = cfg.botToken
/** Never let the bot token reach a log line. */
const scrub = (s: unknown) => String(s).split(botToken).join('***')

const apiToken = ensureApiToken(cfg.configDir)
const store = new RouteStore(join(cfg.stateDir, 'routes.json'))
const hub = new Hub()
const bot = new Bot(botToken)

async function download(fileId: string): Promise<{ data: Buffer; name: string }> {
  try {
    const file = await bot.api.getFile(fileId)
    if (!file.file_path) throw new Error('Telegram не вернул file_path')
    const res = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`)
    if (!res.ok) throw new Error(`download HTTP ${res.status}`)
    return { data: Buffer.from(await res.arrayBuffer()), name: basename(file.file_path) }
  } catch (e) {
    throw new Error(scrub(e instanceof Error ? e.message : e))
  }
}

const media = createMedia({
  download,
  inboxDir: id => join(cfg.stateDir, 'inbox', id),
  deepgram: cfg.deepgramKey ? { key: cfg.deepgramKey, language: cfg.deepgram.language, model: cfg.deepgram.model } : undefined,
})
const tg = createTelegram({ bot: bot as unknown as BotLike, store, hub, media, adminUserId: cfg.adminUserId })

bot.on('message', ctx => tg.onMessage(ctx.message))
bot.on('callback_query:data', ctx =>
  tg.onCallback(
    { id: ctx.callbackQuery.id, from: ctx.callbackQuery.from, data: ctx.callbackQuery.data },
    async text => { await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {}) },
  ),
)
// Without this a throw in a handler stops polling.
bot.catch(err => log(`handler error (polling continues): ${scrub(err.error)}`))

const server = createApi({ store, hub, out: tg, token: apiToken, lostGraceMs: cfg.lostGraceSec * 1000 })
server.listen(cfg.port, '127.0.0.1', () => log(`api on http://127.0.0.1:${cfg.port}`))
server.on('error', e => {
  log(`api error: ${e}`)
  process.exit(1)
})

const idleTimer = setInterval(() => {
  checkIdle(store, tg, Date.now(), cfg.idleHours).catch(e => log(`idle check failed: ${scrub(e)}`))
}, IDLE_CHECK_MS)

let shuttingDown = false
function shutdown(sig: string): void {
  if (shuttingDown) return
  shuttingDown = true
  log(`${sig}, stopping`)
  clearInterval(idleTimer)
  hub.closeAll()
  server.close()
  server.closeAllConnections()
  bot.stop().catch(() => {}).finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Polling with backoff: a network error must not leave the bot deaf while the API keeps running.
for (let attempt = 1; !shuttingDown; attempt++) {
  try {
    await tg.init()
    await bot.start({
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
      onStart: info => {
        attempt = 0
        log(`polling as @${info.username}`)
      },
    })
    break
  } catch (e) {
    if (shuttingDown) break
    if (e instanceof Error && e.message === 'Aborted delay') break
    if (e instanceof GrammyError && e.error_code === 401) {
      log('Telegram отклонил TELEGRAM_BOT_TOKEN (401)')
      process.exit(1)
    }
    const delay = Math.min(1000 * attempt, 15000)
    const what = e instanceof GrammyError && e.error_code === 409 ? '409 Conflict - бот уже кто-то опрашивает' : scrub(e)
    log(`polling error: ${what}, retry in ${delay / 1000}s`)
    await new Promise(r => setTimeout(r, delay))
  }
}
