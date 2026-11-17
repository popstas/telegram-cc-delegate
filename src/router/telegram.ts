import { statSync } from 'node:fs'
import { basename, extname, isAbsolute } from 'node:path'
import { InputFile } from 'grammy'
import type { RouteStore } from '../routes.ts'
import { T } from '../texts.ts'
import { chunk } from './chunk.ts'
import type { Hub } from './hub.ts'
import type { IncomingMessage, Outbound, PermissionRequest, SessionEvent } from './types.ts'

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
  onCallback(q: { id: string; from: { id: number }; data: string }, answer: (text?: string) => Promise<void>): Promise<void>
}

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
const MAX_SEND_BYTES = 50 * 1024 * 1024
const PREVIEW_MAX = 3500
const DESCRIPTION_MAX = 1000
const TEXT_MAX = 4096
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
const CALLBACK_RE = /^perm:(allow|deny|more):([a-km-z]{5})$/
const STOP_RE = /^\s*\/stop(@\w+)?\s*$/i
const LABEL = { allow: 'Разрешено', deny: 'Отклонено' } as const

interface Pending {
  sessionId: string
  userId: string
  req: PermissionRequest
  text: string
  messageId?: number
}

function log(msg: string): void {
  process.stderr.write(`telegram-delegate telegram: ${msg}\n`)
}

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
  now?: () => number
}): Telegram {
  const { bot, store, hub, media, adminUserId } = deps
  const now = deps.now ?? Date.now
  const pending = new Map<string, Pending>()
  let username = ''

  /** Active route: deliver now, or keep for the reconnecting channel server (router restart, grace window). */
  const deliver = (sessionId: string, ev: SessionEvent) => {
    if (!hub.send(sessionId, ev)) hub.enqueue(sessionId, ev)
  }

  const say = (chatId: string, text: string) =>
    bot.api.sendMessage(chatId, text).catch(e => log(`sendMessage to ${chatId} failed: ${e}`))

  async function sendText(userId: string, text: string, replyTo?: string): Promise<string[]> {
    const ids: string[] = []
    const parts = chunk(text)
    for (let i = 0; i < parts.length; i++) {
      const opts = i === 0 && replyTo ? { reply_parameters: { message_id: Number(replyTo) } } : undefined
      const sent = await bot.api.sendMessage(userId, parts[i]!, opts)
      ids.push(String(sent.message_id))
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
    const sent = await bot.api.sendMessage(userId, text, { reply_markup: keyboard(req.request_id, true) })
    p.messageId = sent.message_id
  }

  /** Removes the buttons and shows the verdict on the request message. */
  function closeRequestMessage(p: Pending, label: string): void {
    if (p.messageId == null) return
    bot.api.editMessageText(p.userId, p.messageId, `${p.text}\n\n${label}`).catch(e => log(`edit permission message failed: ${e}`))
  }

  async function onMessage(msg: IncomingMessage): Promise<void> {
    if (msg.chat.type !== 'private' || !msg.from || msg.from.is_bot) return
    const userId = String(msg.from.id)
    const route = store.matchSender({ id: userId, username: msg.from.username })
    if (!route || route.status === 'closed') return void await say(userId, T.noSession)
    if (route.status === 'pending') return void await say(userId, T.pending)
    if (route.status === 'lost') return void await say(userId, T.lost)
    const sessionId = route.sessionId

    if (msg.text && STOP_RE.test(msg.text)) {
      store.setStatus(sessionId, 'closed')
      for (const [id, p] of pending) if (p.sessionId === sessionId) pending.delete(id)
      deliver(sessionId, { type: 'message', content: T.stopToSession, meta: { kind: 'stop' } })
      return void await say(userId, T.stopped)
    }

    const perm = msg.text ? PERMISSION_REPLY_RE.exec(msg.text) : null
    if (perm) {
      const request_id = perm[2]!.toLowerCase()
      const p = pending.get(request_id)
      if (p && p.sessionId === sessionId && p.userId === userId) {
        const behavior = perm[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
        deliver(sessionId, { type: 'permission', request_id, behavior })
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
      log(`media for ${sessionId} failed: ${e}`)
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
    if (!current || current.status !== 'active') return void await say(userId, current?.status === 'lost' ? T.lost : T.noSession)
    deliver(sessionId, { type: 'message', content, meta })
    store.touch(sessionId, now())
  }

  async function onCallback(q: { id: string; from: { id: number }; data: string }, answer: (text?: string) => Promise<void>): Promise<void> {
    const m = CALLBACK_RE.exec(q.data)
    if (!m) return answer()
    const action = m[1] as 'allow' | 'deny' | 'more'
    const request_id = m[2]!
    const p = pending.get(request_id)
    if (!p) return answer(T.stale)
    if (String(q.from.id) !== p.userId) return answer(T.notAuthorized)
    const route = store.get(p.sessionId)
    // A lost or closed session cannot use the verdict: its request ids died with it.
    if (!route || route.status !== 'active') {
      pending.delete(request_id)
      return answer(T.stale)
    }
    if (action === 'more') {
      const preview = p.req.input_preview.slice(0, PREVIEW_MAX)
      const text = `${p.text}\n\n${preview}`.slice(0, TEXT_MAX)
      if (p.messageId != null) {
        await bot.api.editMessageText(p.userId, p.messageId, text, { reply_markup: keyboard(request_id, false) }).catch(e => log(`edit more failed: ${e}`))
      }
      return answer()
    }
    deliver(p.sessionId, { type: 'permission', request_id, behavior: action })
    pending.delete(request_id)
    closeRequestMessage(p, LABEL[action])
    return answer(LABEL[action])
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
