import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename, extname, isAbsolute } from 'node:path'
import { InputFile } from 'grammy'
import type { KnownStore } from '../known.ts'
import type { RouteStore } from '../routes.ts'
import { errInfo, log } from '../log.ts'
import { T } from '../texts.ts'
import { chunk } from './chunk.ts'
import type { Hub } from './hub.ts'
import { BUTTON_TEXT_MAX, BUTTONS_MAX, type AnswerButtons, type IncomingMessage, type Outbound, type PermissionRequest, type SessionEvent } from './types.ts'

export interface BotLike {
  api: {
    sendMessage(chatId: string, text: string, opts?: object): Promise<{ message_id: number }>
    editMessageText(...a: unknown[]): Promise<unknown>
    sendDocument(...a: unknown[]): Promise<{ message_id: number }>
    sendPhoto(...a: unknown[]): Promise<{ message_id: number }>
    sendChatAction(chatId: string, a: 'typing'): Promise<unknown>
    getMe(): Promise<{ username: string }>
  }
}

export interface MediaHandler {
  toEvent(msg: IncomingMessage, sessionId: string): Promise<{ content: string; meta: Record<string, string> } | undefined>
}

export type Telegram = Outbound & {
  /** Caches the bot username (getMe). */
  init(): Promise<void>
  onMessage(msg: IncomingMessage): Promise<void>
  onCallback(q: { id: string; from: { id: number; username?: string }; data: string }, answer: (text?: string) => Promise<void>): Promise<void>
}

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
const MAX_SEND_BYTES = 50 * 1024 * 1024
const PREVIEW_MAX = 3500
const DESCRIPTION_MAX = 1000
const TEXT_MAX = 4096
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
const CALLBACK_RE = /^perm:(allow|deny|more):([a-km-z]{5})$/
const STOP_RE = /^\s*\/stop(@\w+)?\s*$/i
const BUTTON_RE = /^btn:([a-z0-9]{6}):([0-7])$/
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
const LABEL = { allow: 'Разрешено', deny: 'Отклонено' } as const

/** Answer options under a bot message; callback_data carries only the set id and the index. */
interface Choice {
  sessionId: string
  userId: string
  options: string[]
  text: string
  messageId: number
}

function newChoiceId(): string {
  return [...randomBytes(6)].map(b => ID_CHARS[b % ID_CHARS.length]).join('')
}

interface Pending {
  sessionId: string
  userId: string
  req: PermissionRequest
  text: string
  messageId?: number
}

/** Content kind for the routing log. The content itself is never logged. */
export function contentType(msg: IncomingMessage): string {
  if (msg.voice) return 'voice'
  if (msg.audio) return 'audio'
  if (msg.video_note) return 'video_note'
  if (msg.photo?.length) return 'photo'
  if (msg.document) return 'document'
  if (msg.text != null) return 'text'
  const m = msg as unknown as Record<string, unknown>
  return OTHER_TYPES.find(k => m[k] != null) ?? 'other'
}
const OTHER_TYPES = ['sticker', 'video', 'animation', 'location', 'venue', 'contact', 'poll', 'dice', 'story']

const who = (id: number | string, username?: string) => `from=${id}${username ? ` @${username}` : ''}`
const where = (r: { sessionName: string; sessionId: string }) => `${r.sessionName} (${r.sessionId})`

function keyboard(id: string, withMore: boolean) {
  const row = [
    { text: 'Allow', callback_data: `perm:allow:${id}` },
    { text: 'Deny', callback_data: `perm:deny:${id}` },
  ]
  if (withMore) row.push({ text: 'Подробнее', callback_data: `perm:more:${id}` })
  return { inline_keyboard: [row] }
}

export function createTelegram(deps: {
  bot: BotLike
  store: RouteStore
  hub: Pick<Hub, 'send' | 'enqueue'>
  media: MediaHandler
  adminUserId: string
  /** Everyone who writes in private is remembered here: the bot can write to them first. */
  known?: Pick<KnownStore, 'see'>
  now?: () => number
}): Telegram {
  const { bot, store, hub, media, adminUserId } = deps
  const now = deps.now ?? Date.now
  const pending = new Map<string, Pending>()
  const choices = new Map<string, Choice>()
  let username = ''

  /** Active route: deliver now, or keep for the reconnecting channel server (router restart, grace window). */
  const deliver = (sessionId: string, ev: SessionEvent): boolean => {
    if (hub.send(sessionId, ev)) return true
    hub.enqueue(sessionId, ev)
    return false
  }

  const say = (chatId: string, text: string) =>
    bot.api.sendMessage(chatId, text).catch(e => log(`out service-text to ${chatId} failed ${errInfo(e)}`))

  async function sendText(userId: string, text: string, replyTo?: string, buttons?: AnswerButtons): Promise<string[]> {
    if (buttons) {
      if (buttons.options.length > BUTTONS_MAX) throw new Error(`buttons: не больше ${BUTTONS_MAX} вариантов`)
      if (buttons.options.some(o => !o.trim() || o.length > BUTTON_TEXT_MAX)) throw new Error(`buttons: вариант должен быть непустым и не длиннее ${BUTTON_TEXT_MAX} символов`)
    }
    const ids: string[] = []
    const parts = chunk(text)
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1
      const opts: Record<string, unknown> = {}
      if (i === 0 && replyTo) opts.reply_parameters = { message_id: Number(replyTo) }
      let choiceId: string | undefined
      if (last && buttons?.options.length) {
        choiceId = newChoiceId()
        opts.reply_markup = { inline_keyboard: buttons.options.map((o, j) => [{ text: o, callback_data: `btn:${choiceId}:${j}` }]) }
      }
      const sent = await bot.api.sendMessage(userId, parts[i]!, Object.keys(opts).length ? opts : undefined)
      ids.push(String(sent.message_id))
      if (choiceId && buttons) {
        choices.set(choiceId, { sessionId: buttons.sessionId, userId, options: buttons.options, text: parts[i]!, messageId: sent.message_id })
      }
    }
    return ids
  }

  async function sendFiles(userId: string, files: string[]): Promise<string[]> {
    for (const f of files) {
      if (!isAbsolute(f)) throw new Error(`файл ${f}: нужен абсолютный путь`)
      let size: number
      try {
        const st = statSync(f)
        if (!st.isFile()) throw new Error('not a file')
        size = st.size
      } catch {
        throw new Error(`файл ${f} не найден`)
      }
      if (size > MAX_SEND_BYTES) throw new Error(`файл ${basename(f)} больше 50 МБ, Telegram такой не примет`)
    }
    const ids: string[] = []
    for (const f of files) {
      const input = new InputFile(f)
      const sent = PHOTO_EXTS.has(extname(f).toLowerCase())
        ? await bot.api.sendPhoto(userId, input)
        : await bot.api.sendDocument(userId, input)
      ids.push(String(sent.message_id))
    }
    return ids
  }

  async function editText(userId: string, messageId: string, text: string): Promise<void> {
    await bot.api.editMessageText(userId, Number(messageId), text.slice(0, 4096))
  }

  async function askPermission(userId: string, sessionId: string, req: PermissionRequest): Promise<void> {
    const text = `Подтвердить: ${req.tool_name.slice(0, 200)} - ${req.description.slice(0, DESCRIPTION_MAX)}`
    const p: Pending = { sessionId, userId, req, text }
    pending.set(req.request_id, p)
    try {
      const sent = await bot.api.sendMessage(userId, text, { reply_markup: keyboard(req.request_id, true) })
      p.messageId = sent.message_id
      log(`out permission ${sessionId} ${req.request_id} ok`)
    } catch (e) {
      log(`out permission ${sessionId} ${req.request_id} failed ${errInfo(e)}`)
      throw e
    }
  }

  /** Removes the buttons and shows the verdict on the request message. */
  function closeRequestMessage(p: Pending, label: string): void {
    if (p.messageId == null) return
    bot.api.editMessageText(p.userId, p.messageId, `${p.text}\n\n${label}`).catch(e => log(`out permission-close ${p.sessionId} failed ${errInfo(e)}`))
  }

  async function onMessage(msg: IncomingMessage): Promise<void> {
    if (!msg.from) return
    const len = (msg.text ?? msg.caption ?? '').length
    const head = `in msg ${who(msg.from.id, msg.from.username)} chat=${msg.chat.type} type=${contentType(msg)} len=${len}`
    const note = (decision: string) => log(`${head} ${decision}`)
    if (msg.chat.type !== 'private') return note('ignored-group')
    if (msg.from.is_bot) return note('ignored-bot')
    const userId = String(msg.from.id)
    deps.known?.see({ id: userId, username: msg.from.username }, now())
    const route = store.matchSender({ id: userId, username: msg.from.username })
    if (!route || route.status === 'closed') {
      note('no-session')
      return void await say(userId, T.noSession)
    }
    if (route.status === 'pending') {
      note(`pending ${where(route)}`)
      return void await say(userId, T.pending)
    }
    if (route.status === 'lost') {
      note(`lost ${where(route)}`)
      return void await say(userId, T.lost)
    }
    const sessionId = route.sessionId

    if (msg.text && STOP_RE.test(msg.text)) {
      store.setStatus(sessionId, 'closed')
      for (const [id, p] of pending) if (p.sessionId === sessionId) pending.delete(id)
      deliver(sessionId, { type: 'message', content: T.stopToSession, meta: { kind: 'stop' } })
      note(`stop ${where(route)}`)
      return void await say(userId, T.stopped)
    }

    const perm = msg.text ? PERMISSION_REPLY_RE.exec(msg.text) : null
    if (perm) {
      const request_id = perm[2]!.toLowerCase()
      const p = pending.get(request_id)
      if (p && p.sessionId === sessionId && p.userId === userId) {
        const behavior = perm[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
        const sent = deliver(sessionId, { type: 'permission', request_id, behavior })
        note(`verdict ${request_id} ${behavior}${sent ? '' : ' queued'} ${where(route)}`)
        pending.delete(request_id)
        closeRequestMessage(p, LABEL[behavior])
        return
      }
    }

    bot.api.sendChatAction(userId, 'typing').catch(() => {})
    let extra: { content: string; meta: Record<string, string> } | undefined
    try {
      extra = await media.toEvent(msg, sessionId)
    } catch (e) {
      log(`media ${sessionId} failed ${errInfo(e)}`)
      extra = { content: msg.caption ?? '', meta: { media_error: String(e instanceof Error ? e.message : e) } }
    }
    let content = extra ? extra.content : (msg.text ?? msg.caption ?? '')
    if (!content && !extra) content = '[сообщение без текста, такой тип не поддерживается]'
    const meta: Record<string, string> = {
      ...(extra?.meta ?? {}),
      chat_id: String(msg.chat.id),
      message_id: String(msg.message_id),
      user: msg.from.username ?? userId,
      user_id: userId,
      ts: new Date(msg.date * 1000).toISOString(),
      kind: 'guest',
    }
    // The route may have been closed or moved while media was downloading.
    const current = store.get(sessionId)
    if (!current || current.status !== 'active') {
      const lost = current?.status === 'lost'
      note(`${lost ? 'lost' : 'no-session'} ${where(route)} (after media)`)
      return void await say(userId, lost ? T.lost : T.noSession)
    }
    const sent = deliver(sessionId, { type: 'message', content, meta })
    note(`${sent ? '->' : 'queued'} ${where(route)}`)
    store.touch(sessionId, now())
  }

  async function onCallback(q: { id: string; from: { id: number; username?: string }; data: string }, answer: (text?: string) => Promise<void>): Promise<void> {
    const note = (decision: string) => log(`in cb ${who(q.from.id, q.from.username)} ${q.data.slice(0, 64).replace(/\s+/g, '_')} ${decision}`)
    const b = BUTTON_RE.exec(q.data)
    if (b) return onButton(q, b[1]!, Number(b[2]), note, answer)
    const m = CALLBACK_RE.exec(q.data)
    if (!m) {
      note('ignored')
      return answer()
    }
    const action = m[1] as 'allow' | 'deny' | 'more'
    const request_id = m[2]!
    const p = pending.get(request_id)
    if (!p) {
      note('stale')
      return answer(T.stale)
    }
    if (String(q.from.id) !== p.userId) {
      note('not-authorized')
      return answer(T.notAuthorized)
    }
    const route = store.get(p.sessionId)
    // A lost or closed session cannot use the verdict: its request ids died with it.
    if (!route || route.status !== 'active') {
      pending.delete(request_id)
      note(`stale ${route ? where(route) : p.sessionId}`)
      return answer(T.stale)
    }
    if (action === 'more') {
      note(`more ${where(route)}`)
      const preview = p.req.input_preview.slice(0, PREVIEW_MAX)
      const text = `${p.text}\n\n${preview}`.slice(0, TEXT_MAX)
      if (p.messageId != null) {
        await bot.api.editMessageText(p.userId, p.messageId, text, { reply_markup: keyboard(request_id, false) }).catch(e => log(`out permission-more ${p.sessionId} failed ${errInfo(e)}`))
      }
      return answer()
    }
    const sent = deliver(p.sessionId, { type: 'permission', request_id, behavior: action })
    note(`verdict ${request_id} ${action}${sent ? '' : ' queued'} ${where(route)}`)
    pending.delete(request_id)
    closeRequestMessage(p, LABEL[action])
    return answer(LABEL[action])
  }

  async function onButton(
    q: { from: { id: number; username?: string } },
    choiceId: string,
    index: number,
    note: (decision: string) => void,
    answer: (text?: string) => Promise<void>,
  ): Promise<void> {
    const c = choices.get(choiceId)
    if (!c || index >= c.options.length) {
      note('stale')
      return answer(T.stale)
    }
    if (String(q.from.id) !== c.userId) {
      note('not-authorized')
      return answer(T.notAuthorized)
    }
    const route = store.get(c.sessionId)
    if (!route || route.status !== 'active') {
      choices.delete(choiceId)
      note(`stale ${route ? where(route) : c.sessionId}`)
      return answer(T.stale)
    }
    const option = c.options[index]!
    choices.delete(choiceId)
    const sent = deliver(c.sessionId, {
      type: 'message',
      content: option,
      meta: {
        chat_id: c.userId,
        message_id: String(c.messageId),
        user: q.from.username ?? c.userId,
        user_id: c.userId,
        ts: new Date(now()).toISOString(),
        kind: 'button',
      },
    })
    note(`button ${choiceId} ${sent ? '->' : 'queued'} ${where(route)}`)
    store.touch(c.sessionId, now())
    bot.api.editMessageText(c.userId, c.messageId, `${c.text}\n\nВыбрано: ${option}`.slice(0, TEXT_MAX)).catch(e => log(`out button-close ${c.sessionId} failed ${errInfo(e)}`))
    return answer()
  }

  return {
    async init() {
      username = (await bot.api.getMe()).username
    },
    botUsername: () => username,
    sendText,
    sendFiles,
    editText,
    askPermission,
    notifyAdmin: async text => { await sendText(adminUserId, text) },
    onMessage,
    onCallback,
  }
}
