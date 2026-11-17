import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApi } from '../src/router/api.ts'
import { Hub } from '../src/router/hub.ts'
import type { Outbound, PermissionRequest } from '../src/router/types.ts'
import { RouteStore } from '../src/routes.ts'

const TOKEN = 'secret-token'

type Call = { fn: string; args: unknown[] }
function fakeOut(): Outbound & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    async sendText(...args) { calls.push({ fn: 'sendText', args }); return ['100'] },
    async sendFiles(...args) { calls.push({ fn: 'sendFiles', args }); return ['101'] },
    async editText(...args) { calls.push({ fn: 'editText', args }) },
    async askPermission(...args) { calls.push({ fn: 'askPermission', args }) },
    async notifyAdmin(...args) { calls.push({ fn: 'notifyAdmin', args }) },
    botUsername: () => 'td_test_bot',
  }
}

const servers: http.Server[] = []
const aborts: AbortController[] = []
afterEach(() => {
  for (const a of aborts.splice(0)) a.abort()
  for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() }
})

function setup(opts: { lostGraceMs?: number; prepare?: (s: RouteStore) => void; files?: { stateDir: string; configDir: string } } = {}) {
  const store = new RouteStore(join(mkdtempSync(join(tmpdir(), 'td-api-')), 'routes.json'))
  opts.prepare?.(store)
  const hub = new Hub()
  const out = fakeOut()
  const server = createApi({ store, hub, out, token: TOKEN, lostGraceMs: opts.lostGraceMs ?? 1000, files: opts.files })
  servers.push(server)
  return new Promise<{ store: RouteStore; hub: Hub; out: ReturnType<typeof fakeOut>; url: string }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ store, hub, out, url: `http://127.0.0.1:${port}` })
    })
  })
}

async function call(url: string, method: string, path: string, body?: unknown, auth = true) {
  const res = await fetch(url + path, {
    method,
    headers: { ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : undefined }
}

/** Opens an SSE subscription; resolves once headers arrived. */
async function subscribe(url: string, sessionId: string) {
  const ac = new AbortController()
  aborts.push(ac)
  const res = await fetch(`${url}/sessions/${sessionId}/events`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: ac.signal })
  const events: unknown[] = []
  if (res.ok && res.body) {
    void (async () => {
      const dec = new TextDecoder()
      let buf = ''
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += dec.decode(chunk, { stream: true })
          let i: number
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i)
            buf = buf.slice(i + 2)
            const data = block.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n')
            if (data) events.push(JSON.parse(data))
          }
        }
      } catch { /* aborted */ }
    })()
  }
  return { status: res.status, events, close: () => ac.abort() }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 1000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout')
    await sleep(5)
  }
}

const route = { sessionId: 's1', sessionName: 'guest-task', headId: 'head-1', tgUsername: 'alexiapost' }

describe('router api', () => {
  it('rejects without bearer', async () => {
    const { url } = await setup()
    for (const [m, p] of [['GET', '/health'], ['GET', '/routes'], ['POST', '/routes'], ['GET', '/sessions/s1/events'], ['POST', '/sessions/s1/reply'], ['GET', '/nope']]) {
      expect((await call(url, m!, p!, undefined, false)).status).toBe(401)
    }
    const wrong = await fetch(url + '/health', { headers: { authorization: 'Bearer nope' } })
    expect(wrong.status).toBe(401)
  })

  it('health returns bot username', async () => {
    const { url } = await setup()
    expect((await call(url, 'GET', '/health')).json).toEqual({ ok: true, botUsername: 'td_test_bot' })
  })

  it('routes crud', async () => {
    const { url } = await setup()
    const created = await call(url, 'POST', '/routes', route)
    expect(created.status).toBe(201)
    expect(created.json.route.status).toBe('pending')
    expect((await call(url, 'POST', '/routes', { sessionId: 'x' })).status).toBe(400)
    expect((await call(url, 'GET', '/routes')).json.routes).toHaveLength(1)
    const del = await call(url, 'DELETE', '/routes/s1')
    expect(del.status).toBe(200)
    expect(del.json.route.status).toBe('closed')
    expect((await call(url, 'DELETE', '/routes/zzz')).status).toBe(404)
  })

  it('events activates pending route', async () => {
    const { url, store } = await setup()
    await call(url, 'POST', '/routes', route)
    const sub = await subscribe(url, 's1')
    expect(sub.status).toBe(200)
    await until(() => store.get('s1')?.status === 'active')
  })

  it('events 404 for unknown or closed', async () => {
    const { url } = await setup()
    expect((await subscribe(url, 'nope')).status).toBe(404)
    await call(url, 'POST', '/routes', route)
    await call(url, 'DELETE', '/routes/s1')
    expect((await subscribe(url, 's1')).status).toBe(404)
  })

  it('disconnect then grace marks lost and notifies admin', async () => {
    const { url, store, out } = await setup({ lostGraceMs: 50 })
    await call(url, 'POST', '/routes', route)
    const sub = await subscribe(url, 's1')
    await until(() => store.get('s1')?.status === 'active')
    sub.close()
    await sleep(150)
    expect(store.get('s1')?.status).toBe('lost')
    const admin = out.calls.filter(c => c.fn === 'notifyAdmin')
    expect(admin).toHaveLength(1)
    expect(admin[0]!.args[0]).toBe('Сессия завершена')
  })

  it('reconnect within grace keeps active', async () => {
    const { url, store, out, hub } = await setup({ lostGraceMs: 100 })
    await call(url, 'POST', '/routes', route)
    const sub = await subscribe(url, 's1')
    await until(() => hub.connected('s1'))
    sub.close()
    await until(() => !hub.connected('s1'))
    await sleep(10)
    await subscribe(url, 's1')
    await sleep(200)
    expect(store.get('s1')?.status).toBe('active')
    expect(out.calls.filter(c => c.fn === 'notifyAdmin')).toHaveLength(0)
  })

  it('restart: active route without subscriber goes lost after grace', async () => {
    const { store, out } = await setup({
      lostGraceMs: 50,
      prepare: s => { s.upsert(route, 0); s.setStatus('s1', 'active') },
    })
    await sleep(150)
    expect(store.get('s1')?.status).toBe('lost')
    expect(out.calls.filter(c => c.fn === 'notifyAdmin')).toHaveLength(1)
  })

  it('lost route reactivates on subscribe', async () => {
    const { url, store } = await setup({ prepare: s => { s.upsert(route, 0); s.setStatus('s1', 'lost') } })
    await subscribe(url, 's1')
    await until(() => store.get('s1')?.status === 'active')
  })

  it('reply 409 before guest wrote', async () => {
    const { url } = await setup()
    await call(url, 'POST', '/routes', route)
    const r = await call(url, 'POST', '/sessions/s1/reply', { text: 'hi' })
    expect(r.status).toBe(409)
    expect(r.json.error).toBe('гость ещё не писал боту')
  })

  it('reply sends to tgUserId', async () => {
    const { url, out } = await setup()
    await call(url, 'POST', '/routes', { ...route, tgUserId: '42' })
    const r = await call(url, 'POST', '/sessions/s1/reply', { text: 'hi', files: ['/tmp/a.png'], reply_to: '7' })
    expect(r.status).toBe(200)
    expect(r.json.message_ids).toEqual(['100', '101'])
    expect(out.calls[0]).toEqual({ fn: 'sendText', args: ['42', 'hi', '7'] })
    expect(out.calls[1]).toEqual({ fn: 'sendFiles', args: ['42', ['/tmp/a.png']] })
  })

  it('reply 404 unknown, 410 closed, 400 bad body', async () => {
    const { url } = await setup()
    expect((await call(url, 'POST', '/sessions/zz/reply', { text: 'hi' })).status).toBe(404)
    await call(url, 'POST', '/routes', { ...route, tgUserId: '42' })
    expect((await call(url, 'POST', '/sessions/s1/reply', { nope: 1 })).status).toBe(400)
    await call(url, 'DELETE', '/routes/s1')
    expect((await call(url, 'POST', '/sessions/s1/reply', { text: 'hi' })).status).toBe(410)
  })

  it('edit and permission', async () => {
    const { url, out } = await setup()
    await call(url, 'POST', '/routes', { ...route, tgUserId: '42' })
    expect((await call(url, 'POST', '/sessions/s1/edit', { message_id: '5', text: 'done' })).status).toBe(200)
    expect(out.calls[0]).toEqual({ fn: 'editText', args: ['42', '5', 'done'] })
    const req: PermissionRequest = { request_id: 'abcde', tool_name: 'Bash', description: 'run ls', input_preview: '{"command":"ls"}' }
    expect((await call(url, 'POST', '/sessions/s1/permission', req)).status).toBe(202)
    expect(out.calls[1]).toEqual({ fn: 'askPermission', args: ['42', 's1', req] })
  })

  it('post routes moves and notifies old session', async () => {
    const { url, store, out } = await setup()
    await call(url, 'POST', '/routes', route)
    const sub = await subscribe(url, 's1')
    await until(() => store.get('s1')?.status === 'active')
    const r = await call(url, 'POST', '/routes', { ...route, sessionId: 's2', sessionName: 'next-task', tgUsername: '@AlexiaPost' })
    expect(r.status).toBe(201)
    expect(r.json.moved.sessionId).toBe('s1')
    await until(() => sub.events.length > 0)
    expect(sub.events[0]).toEqual({ type: 'message', content: 'Гость перешёл в другую сессию и сюда больше не пишет.', meta: { kind: 'moved' } })
    const admin = out.calls.filter(c => c.fn === 'notifyAdmin')
    expect(admin.map(c => c.args[0])).toEqual(['telegram-delegate: маршрут @alexiapost перенесён из guest-task в next-task.'])
  })

  it('hub send reaches subscriber and reports missing one', async () => {
    const { url, hub } = await setup()
    await call(url, 'POST', '/routes', route)
    const sub = await subscribe(url, 's1')
    await until(() => hub.connected('s1'))
    expect(hub.send('s1', { type: 'permission', request_id: 'abcde', behavior: 'allow' })).toBe(true)
    expect(hub.send('s2', { type: 'permission', request_id: 'abcde', behavior: 'allow' })).toBe(false)
    await until(() => sub.events.length > 0)
    expect(sub.events[0]).toEqual({ type: 'permission', request_id: 'abcde', behavior: 'allow' })
  })

  it('move found on first message (username route after id route) notifies old session', async () => {
    const { url, store, out } = await setup()
    await call(url, 'POST', '/routes', { ...route, tgUsername: undefined, tgUserId: '42' })
    const sub = await subscribe(url, 's1')
    await until(() => store.get('s1')?.status === 'active')
    const r = await call(url, 'POST', '/routes', { ...route, sessionId: 's2', sessionName: 'next-task' })
    expect(r.json.moved).toBeUndefined()
    expect(store.matchSender({ id: '42', username: 'alexiapost' })?.sessionId).toBe('s2')
    await until(() => sub.events.length > 0)
    expect(sub.events[0]).toMatchObject({ type: 'message', meta: { kind: 'moved' } })
    expect(out.calls.filter(c => c.fn === 'notifyAdmin').map(c => c.args[0])).toEqual(['telegram-delegate: маршрут @alexiapost перенесён из guest-task в next-task.'])
  })

  it('queued events are flushed on reconnect', async () => {
    const { url, hub } = await setup({ prepare: s => { s.upsert({ ...route, tgUserId: '42' }, 0); s.setStatus('s1', 'active') } })
    hub.enqueue('s1', { type: 'message', content: 'пока рестарт', meta: { kind: 'guest' } })
    const sub = await subscribe(url, 's1')
    await until(() => sub.events.length > 0)
    expect(sub.events[0]).toMatchObject({ content: 'пока рестарт' })
  })

  it('lost drops queued events and tells the guest', async () => {
    const { store, hub, out } = await setup({ lostGraceMs: 50, prepare: s => { s.upsert({ ...route, tgUserId: '42' }, 0); s.setStatus('s1', 'active') } })
    hub.enqueue('s1', { type: 'message', content: 'в пустоту?', meta: { kind: 'guest' } })
    await sleep(150)
    expect(store.get('s1')?.status).toBe('lost')
    expect(out.calls.filter(c => c.fn === 'sendText')).toEqual([{ fn: 'sendText', args: ['42', 'Сессия прервалась, Стас в курсе.'] }])
    expect(hub.dropQueue('s1')).toBe(0)
  })

  it('reply refuses router state and config files, allows own inbox', async () => {
    const root = mkdtempSync(join(tmpdir(), 'td-guard-'))
    const stateDir = join(root, 'state')
    const configDir = join(root, 'config')
    for (const d of [join(stateDir, 'inbox', 's1'), join(stateDir, 'inbox', 'other'), configDir]) mkdirSync(d, { recursive: true })
    const own = join(stateDir, 'inbox', 's1', 'a.png')
    const foreign = join(stateDir, 'inbox', 'other', 'b.png')
    for (const f of [own, foreign, join(stateDir, 'routes.json'), join(configDir, 'api-token')]) writeFileSync(f, 'x')
    const { url, out } = await setup({ files: { stateDir, configDir } })
    await call(url, 'POST', '/routes', { ...route, tgUserId: '42' })
    for (const f of [foreign, join(stateDir, 'routes.json'), join(configDir, 'api-token'), join(stateDir, 'inbox', 's1', '..', 'other', 'b.png')]) {
      const r = await call(url, 'POST', '/sessions/s1/reply', { text: '', files: [f] })
      expect(r.status).toBe(403)
    }
    expect(out.calls).toEqual([])
    expect((await call(url, 'POST', '/sessions/s1/reply', { text: '', files: [own] })).status).toBe(200)
  })

  it('reply passes buttons and validates limits', async () => {
    const { url, out } = await setup()
    await call(url, 'POST', '/routes', { ...route, tgUserId: '42' })
    expect((await call(url, 'POST', '/sessions/s1/reply', { text: 'выбор', buttons: ['A', 'B'] })).status).toBe(200)
    expect(out.calls[0]).toEqual({ fn: 'sendText', args: ['42', 'выбор', undefined, { sessionId: 's1', options: ['A', 'B'] }] })
    const nine = Array.from({ length: 9 }, (_, i) => `v${i}`)
    expect((await call(url, 'POST', '/sessions/s1/reply', { text: 'выбор', buttons: nine })).status).toBe(400)
    expect((await call(url, 'POST', '/sessions/s1/reply', { text: 'выбор', buttons: ['x'.repeat(65)] })).status).toBe(400)
    expect((await call(url, 'POST', '/sessions/s1/reply', { text: 'выбор', buttons: [' '] })).status).toBe(400)
    expect((await call(url, 'POST', '/sessions/s1/reply', { text: '', files: ['/tmp/a'], buttons: ['A'] })).status).toBe(400)
    expect(out.calls).toHaveLength(1)
  })
})

