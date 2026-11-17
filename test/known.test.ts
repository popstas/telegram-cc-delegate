import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KnownStore } from '../src/known.ts'
import { setLogSink } from '../src/log.ts'
import { createApi } from '../src/router/api.ts'
import { Hub } from '../src/router/hub.ts'
import { createTelegram, type BotLike } from '../src/router/telegram.ts'
import type { Outbound } from '../src/router/types.ts'
import { RouteStore, type Route } from '../src/routes.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'td-known-'))
const route = (o: Partial<Route>): Route => ({ sessionId: 's', sessionName: 'n', headId: 'h', status: 'active', createdAt: 1, ...o })

describe('KnownStore', () => {
  it('remembers username and id, lowercased, persisted with mode 600', () => {
    const file = join(dir(), 'known.json')
    const k = new KnownStore(file)
    k.see({ id: '42', username: '@AlexiaPost' }, 1000)
    expect(k.idByUsername('alexiapost')).toBe('42')
    expect(k.idByUsername('@ALEXIAPOST')).toBe('42')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const again = new KnownStore(file)
    expect(again.list()).toEqual([{ id: '42', username: 'alexiapost', lastSeenAt: 1000 }])
    expect(readFileSync(file, 'utf8')).not.toMatch(/text|content/)
  })

  it('rename replaces the pair, reassigned username moves to the new owner', () => {
    const k = new KnownStore(join(dir(), 'known.json'))
    k.see({ id: '42', username: 'old' }, 1)
    k.see({ id: '42', username: 'new' }, 2)
    expect(k.idByUsername('old')).toBeUndefined()
    expect(k.idByUsername('new')).toBe('42')
    k.see({ id: '77', username: 'new' }, 3)
    expect(k.idByUsername('new')).toBe('77')
    expect(k.has('42')).toBe(true)
  })

  it('person without username keeps the id only', () => {
    const k = new KnownStore(join(dir(), 'known.json'))
    k.see({ id: '42', username: 'gone' }, 1)
    k.see({ id: '42' }, 2)
    expect(k.idByUsername('gone')).toBeUndefined()
    expect(k.has('42')).toBe(true)
  })

  it('seed takes routes with both fields and never overwrites newer entries', () => {
    const k = new KnownStore(join(dir(), 'known.json'))
    k.see({ id: '42', username: 'fresh' }, 5000)
    const n = k.seed([
      route({ sessionId: 'a', tgUsername: 'stale', tgUserId: '42', lastMessageAt: 100 }),
      route({ sessionId: 'b', tgUsername: 'wyrtensi', tgUserId: '77', createdAt: 200 }),
      route({ sessionId: 'c', tgUsername: 'onlyname' }),
      route({ sessionId: 'd', tgUserId: '99' }),
    ])
    expect(n).toBe(1)
    expect(k.idByUsername('fresh')).toBe('42')
    expect(k.idByUsername('stale')).toBeUndefined()
    expect(k.list().find(p => p.id === '77')).toEqual({ id: '77', username: 'wyrtensi', lastSeenAt: 200 })
    expect(k.has('99')).toBe(false)
  })

  it('corrupt file starts empty instead of crashing', () => {
    const file = join(dir(), 'known.json')
    writeFileSync(file, '{not json')
    const lines: string[] = []
    const prev = setLogSink(l => lines.push(l))
    try {
      const k = new KnownStore(file)
      expect(k.list()).toEqual([])
      expect(lines.join('\n')).toMatch(/known.json unreadable/)
    } finally {
      setLogSink(prev)
    }
  })
})

function fakeBot(): BotLike {
  return {
    api: {
      async sendMessage() { return { message_id: 1 } },
      async editMessageText() { return true },
      async sendDocument() { return { message_id: 2 } },
      async sendPhoto() { return { message_id: 3 } },
      async sendChatAction() { return true },
      async getMe() { return { username: 'td_bot' } },
    },
  }
}

describe('telegram side records senders', () => {
  it('private messages are remembered (also without a session), groups and bots are not', async () => {
    const d = dir()
    const store = new RouteStore(join(d, 'routes.json'))
    const known = new KnownStore(join(d, 'known.json'))
    const tg = createTelegram({ bot: fakeBot(), store, hub: { send: () => true, enqueue: () => {} }, media: { toEvent: async () => undefined }, adminUserId: '1', known, now: () => 7000 })
    const base = { message_id: 1, date: 1, text: 'секрет гостя' }
    await tg.onMessage({ ...base, chat: { id: 42, type: 'private' }, from: { id: 42, username: 'Wyrtensi' } })
    await tg.onMessage({ ...base, chat: { id: -100, type: 'group' }, from: { id: 55, username: 'groupie' } })
    await tg.onMessage({ ...base, chat: { id: 66, type: 'private' }, from: { id: 66, username: 'somebot', is_bot: true } })
    expect(known.list()).toEqual([{ id: '42', username: 'wyrtensi', lastSeenAt: 7000 }])
    expect(readFileSync(join(d, 'known.json'), 'utf8')).not.toContain('секрет')
  })
})

function fakeOut(): Outbound {
  return {
    async sendText() { return ['1'] },
    async sendFiles() { return [] },
    async editText() {},
    async askPermission() {},
    async notifyAdmin() {},
    botUsername: () => 'td_bot',
  }
}

const servers: http.Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() }
})

async function api(opts: { writeFirst?: boolean; known?: boolean } = {}) {
  const d = dir()
  const store = new RouteStore(join(d, 'routes.json'))
  const known = new KnownStore(join(d, 'known.json'))
  known.see({ id: '42', username: 'wyrtensi' }, 1)
  const server = createApi({ store, hub: new Hub(), out: fakeOut(), token: 't', lostGraceMs: 1000, ...(opts.known !== false && { known }), writeFirst: opts.writeFirst })
  servers.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(url + path, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, json: await res.json() }
  }
  return { store, call }
}

const input = { sessionId: 's1', sessionName: 'week', headId: 'h' }

describe('POST /routes with known people', () => {
  it('username route gets the id from memory, canWriteFirst and writeFirst from config', async () => {
    const { store, call } = await api({ writeFirst: true })
    const r = await call('POST', '/routes', { ...input, tgUsername: '@Wyrtensi' })
    expect(r.status).toBe(201)
    expect(r.json.route.tgUserId).toBe('42')
    expect(r.json).toMatchObject({ canWriteFirst: true, writeFirst: true })
    expect(store.get('s1')!.tgUserId).toBe('42')
  })

  it('unknown username: no id, cannot write first even when config says so', async () => {
    const { call } = await api({ writeFirst: true })
    const r = await call('POST', '/routes', { ...input, tgUsername: 'stranger' })
    expect(r.json.route.tgUserId).toBeUndefined()
    expect(r.json).toMatchObject({ canWriteFirst: false, writeFirst: false })
  })

  it('id from the request counts; config off gives writeFirst false', async () => {
    const { call } = await api()
    const r = await call('POST', '/routes', { ...input, tgUserId: '777' })
    expect(r.json).toMatchObject({ canWriteFirst: true, writeFirst: false })
  })

  it('GET /known answers the same without creating a route', async () => {
    const { store, call } = await api({ writeFirst: true })
    expect((await call('GET', '/known?tgUsername=WYRTENSI')).json).toEqual({ known: true, tgUserId: '42', canWriteFirst: true, writeFirst: true })
    expect((await call('GET', '/known?tgUsername=stranger')).json).toEqual({ known: false, canWriteFirst: false, writeFirst: false })
    expect((await call('GET', '/known?tgUserId=777')).json).toEqual({ known: false, tgUserId: '777', canWriteFirst: true, writeFirst: true })
    expect((await call('GET', '/known')).status).toBe(400)
    expect(store.list()).toEqual([])
  })

  it('without a known store the API still works', async () => {
    const { call } = await api({ known: false })
    const r = await call('POST', '/routes', { ...input, tgUsername: 'wyrtensi' })
    expect(r.json).toMatchObject({ canWriteFirst: false, writeFirst: false })
  })
})
