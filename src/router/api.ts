import { createHash, timingSafeEqual } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import type { Route, RouteStore } from '../routes.ts'
import { errInfo, log } from '../log.ts'
import { A, T } from '../texts.ts'
import { assertSendable } from './files.ts'
import type { Hub } from './hub.ts'
import { BUTTON_TEXT_MAX, BUTTONS_MAX, type Outbound } from './types.ts'

const MAX_BODY = 1024 * 1024

const routeInput = z.object({
  sessionId: z.string().min(1).max(200),
  sessionName: z.string().min(1).max(200),
  headId: z.string().max(200),
  tgUsername: z.string().max(64).optional(),
  tgUserId: z.string().regex(/^\d+$/).optional(),
}).refine(r => r.tgUsername || r.tgUserId, { message: 'tgUsername or tgUserId required' })

const replyBody = z.object({
  text: z.string(),
  files: z.array(z.string()).optional(),
  reply_to: z.string().optional(),
  buttons: z.array(z.string().trim().min(1).max(BUTTON_TEXT_MAX)).max(BUTTONS_MAX).optional(),
})
  .refine(r => r.text.length > 0 || (r.files?.length ?? 0) > 0, { message: 'text or files required' })
  .refine(r => !r.buttons?.length || r.text.length > 0, { message: 'buttons need text' })

const editBody = z.object({ message_id: z.string().min(1), text: z.string().min(1) })

const permissionBody = z.object({
  request_id: z.string().min(1),
  tool_name: z.string(),
  description: z.string(),
  input_preview: z.string(),
})

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest()
}

function authorized(req: IncomingMessage, token: string): boolean {
  const h = req.headers.authorization ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(h)
  if (!m) return false
  return timingSafeEqual(digest(m[1]!.trim()), digest(token))
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'body too large')
    chunks.push(c as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'invalid json')
  }
}

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data)
  if (!r.success) throw new HttpError(400, r.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
  return r.data
}


export function createApi(deps: {
  store: RouteStore
  hub: Hub
  out: Outbound
  token: string
  lostGraceMs: number
  now?: () => number
  /** Router dirs that reply.files must not reach (except the session's own inbox). */
  files?: { stateDir: string; configDir: string }
}): http.Server {
  const { store, hub, out, token, lostGraceMs } = deps
  const now = deps.now ?? Date.now
  const lostTimers = new Map<string, NodeJS.Timeout>()

  /** kind/subject go to the log, the text only to the admin. */
  const notifyAdmin = (kind: string, subject: string, text: string) => {
    out.notifyAdmin(text).then(
      () => log(`admin ${kind} ${subject} ok`),
      e => log(`admin ${kind} ${subject} failed ${errInfo(e)}`),
    )
  }

  const clearLost = (sessionId: string) => {
    const t = lostTimers.get(sessionId)
    if (t) clearTimeout(t)
    lostTimers.delete(sessionId)
  }

  const scheduleLost = (sessionId: string) => {
    clearLost(sessionId)
    const t = setTimeout(() => {
      lostTimers.delete(sessionId)
      const r = store.get(sessionId)
      if (!r || r.status !== 'active' || hub.connected(sessionId)) return
      store.setStatus(sessionId, 'lost')
      log(`session ${sessionId} lost`)
      notifyAdmin('lost', sessionId, A.lost(r))
      // Guest messages queued for the reconnect will never arrive: say so instead of silence.
      if (hub.dropQueue(sessionId) > 0 && r.tgUserId) {
        out.sendText(r.tgUserId, T.lost).catch(e => log(`out lost-notice ${sessionId} failed ${errInfo(e)}`))
      }
    }, lostGraceMs)
    t.unref()
    lostTimers.set(sessionId, t)
  }

  /** The guest moved to another session: tell the old one and the admin. */
  const handleMoved = (from: Route, to: Route) => {
    clearLost(from.sessionId)
    hub.dropQueue(from.sessionId)
    hub.send(from.sessionId, { type: 'message', content: T.movedToSession, meta: { kind: 'moved' } })
    notifyAdmin('moved', `${from.sessionId} -> ${to.sessionId}`, A.moved(from, to))
  }
  store.onMoved(handleMoved)

  hub.onDetach(sessionId => {
    log(`session ${sessionId} disconnected`)
    if (store.get(sessionId)?.status === 'active') scheduleLost(sessionId)
  })
  // Router restart: active routes get the grace period to reconnect.
  for (const r of store.list()) {
    if (r.status === 'active' && !hub.connected(r.sessionId)) scheduleLost(r.sessionId)
  }

  /** Route usable for sending to the guest. */
  const guestRoute = (sessionId: string): Route & { tgUserId: string } => {
    const r = store.get(sessionId)
    if (!r) throw new HttpError(404, 'route not found')
    if (r.status === 'closed') throw new HttpError(410, 'route closed')
    if (!r.tgUserId) throw new HttpError(409, T.notWrittenYet)
    return r as Route & { tgUserId: string }
  }

  /** Telegram call on behalf of a session: failures are logged with the Telegram code and become 502. */
  const outbound = async <R>(label: string | null, fn: () => Promise<R>): Promise<R> => {
    try {
      return await fn()
    } catch (e) {
      if (label) log(`out ${label} failed ${errInfo(e)}`)
      throw new HttpError(502, e instanceof Error ? e.message : String(e))
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(req, token)) return send(res, 401, { error: 'unauthorized' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (method === 'GET' && path === '/health') return send(res, 200, { ok: true, botUsername: out.botUsername() })
    if (method === 'GET' && path === '/routes') return send(res, 200, { routes: store.list() })
    if (method === 'POST' && path === '/routes') {
      const input = parse(routeInput, await readJson(req))
      const { route, moved } = store.upsert(input, now())
      if (moved) handleMoved(moved, route)
      return send(res, 201, moved ? { route, moved } : { route })
    }

    let m = /^\/routes\/([^/]+)$/.exec(path)
    if (m && method === 'DELETE') {
      const id = decodeURIComponent(m[1]!)
      if (!store.get(id)) throw new HttpError(404, 'route not found')
      clearLost(id)
      hub.dropQueue(id)
      return send(res, 200, { route: store.setStatus(id, 'closed') })
    }

    m = /^\/sessions\/([^/]+)\/(events|reply|edit|permission)$/.exec(path)
    if (m) {
      const id = decodeURIComponent(m[1]!)
      const action = m[2]!
      if (action === 'events' && method === 'GET') {
        const r = store.get(id)
        if (!r || r.status === 'closed') throw new HttpError(404, 'route not found')
        clearLost(id)
        if (r.status !== 'active') store.setStatus(id, 'active')
        hub.attach(id, res)
        log(`session ${id} connected`)
        return
      }
      if (action === 'reply' && method === 'POST') {
        const body = parse(replyBody, await readJson(req))
        const r = guestRoute(id)
        if (deps.files) {
          for (const f of body.files ?? []) {
            try {
              assertSendable(f, id, deps.files)
            } catch (e) {
              throw new HttpError(403, e instanceof Error ? e.message : String(e))
            }
          }
        }
        const buttons = body.buttons?.length ? { sessionId: id, options: body.buttons } : undefined
        const textIds = body.text
          ? await outbound(`reply ${id}`, () => buttons ? out.sendText(r.tgUserId, body.text, body.reply_to, buttons) : out.sendText(r.tgUserId, body.text, body.reply_to))
          : []
        const fileIds = body.files?.length ? await outbound(`reply ${id}`, () => out.sendFiles(r.tgUserId, body.files!)) : []
        log(`out reply ${id} chunks=${textIds.length} files=${fileIds.length}${buttons ? ` buttons=${buttons.options.length}` : ''} ok`)
        return send(res, 200, { message_ids: [...textIds, ...fileIds] })
      }
      if (action === 'edit' && method === 'POST') {
        const body = parse(editBody, await readJson(req))
        const r = guestRoute(id)
        await outbound(`edit ${id}`, () => out.editText(r.tgUserId, body.message_id, body.text))
        log(`out edit ${id} ok`)
        return send(res, 200, { ok: true })
      }
      if (action === 'permission' && method === 'POST') {
        const body = parse(permissionBody, await readJson(req))
        const r = guestRoute(id)
        await outbound(null, () => out.askPermission(r.tgUserId, id, body))
        return send(res, 202, { ok: true })
      }
    }
    throw new HttpError(404, 'not found')
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => {
      const status = e instanceof HttpError ? e.status : 500
      // Status only: 4xx messages can carry file names. 502 was logged with its Telegram code already.
      if (status === 500) log(`api ${req.method} ${(req.url ?? '').split('?')[0]} 500 ${errInfo(e)}`)
      else if (status !== 502 && status !== 401) log(`api ${req.method} ${(req.url ?? '').split('?')[0]} ${status}`)
      if (!res.headersSent) send(res, status, { error: e instanceof Error ? e.message : String(e) })
      else res.end()
    })
  })
  server.on('close', () => {
    for (const t of lostTimers.values()) clearTimeout(t)
    lostTimers.clear()
    hub.closeAll()
  })
  return server
}
