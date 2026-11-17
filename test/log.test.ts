import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLogSink } from '../src/log.ts'
import { createApi } from '../src/router/api.ts'
import { Hub } from '../src/router/hub.ts'
import { checkIdle } from '../src/router/idle.ts'
import { createTelegram, type BotLike, type MediaHandler } from '../src/router/telegram.ts'
import type { IncomingMessage, Outbound, SessionEvent } from '../src/router/types.ts'
import { RouteStore } from '../src/routes.ts'

const SECRET = 'секретный текст гостя'
let lines: string[] = []
let restore: ((l: string) => void) | undefined
beforeEach(() => {
  lines = []
  restore = setLogSink(l => { lines.push(l) })
})
afterEach(() => { if (restore) setLogSink(restore) })

function botStub(fail?: { code: number; description: string }): BotLike {
  let id = 100
  const maybeFail = async () => {
    if (fail) throw Object.assign(new Error(`Call failed! (${fail.code}: ${fail.description})`), { error_code: fail.code, description: fail.description })
  }
  return {
    api: {
      async sendMessage() { await maybeFail(); return { message_id: ++id } },
      async editMessageText() { await maybeFail(); return true },
      async sendDocument() { await maybeFail(); return { message_id: ++id } },
      async sendPhoto() { await maybeFail(); return { message_id: ++id } },
      async sendChatAction() { return true },
      async getMe() { return { username: 'bot' } },
    },
  }
}

function hubStub(connected: boolean) {
  return {
    send: (_s: string, _e: SessionEvent) => connected,
    enqueue: () => {},
  }
}

function setup(opts: { status?: 'pending' | 'active' | 'lost' | 'closed'; connected?: boolean; media?: MediaHandler } = {}) {
  const store = new RouteStore(join(mkdtempSync(join(tmpdir(), 'td-log-')), 'routes.json'))
  store.upsert({ sessionId: 's1', sessionName: 'guest-task', headId: 'h', tgUsername: 'alexiapost' }, 0)
  store.setStatus('s1', opts.status ?? 'active')
  const tg = createTelegram({ bot: botStub(), store, hub: hubStub(opts.connected ?? true), media: opts.media ?? { toEvent: async () => undefined }, adminUserId: '1' })
  return { tg, store }
}

function msg(o: Partial<IncomingMessage> & { fromId?: number; username?: string; chatType?: string } = {}): IncomingMessage {
  const id = o.fromId ?? 42
  return {
    message_id: 7,
    date: 1_700_000_000,
    chat: { id, type: o.chatType ?? 'private' },
    from: { id, ...(o.username !== '' ? { username: o.username ?? 'alexiapost' } : {}) },
    ...(o.text !== undefined || o.caption !== undefined ? {} : { text: SECRET }),
    ...o,
  } as IncomingMessage
}

const noSecret = () => { for (const l of lines) expect(l).not.toContain('секрет') }

describe('routing log', () => {
  it('guest text routed to session', async () => {
    const { tg } = setup()
    await tg.onMessage(msg())
    expect(lines).toContain(`in msg from=42 @alexiapost chat=private type=text len=${SECRET.length} -> guest-task (s1)`)
    noSecret()
  })

  it('queued when no subscriber', async () => {
    const { tg } = setup({ connected: false })
    await tg.onMessage(msg())
    expect(lines).toContain(`in msg from=42 @alexiapost chat=private type=text len=${SECRET.length} queued guest-task (s1)`)
  })

  it('stranger without username, group, pending, lost, stop', async () => {
    const { tg } = setup()
    await tg.onMessage(msg({ fromId: 999, username: '' }))
    await tg.onMessage(msg({ fromId: 5, chatType: 'supergroup', username: 'x' }))
    expect(lines).toEqual([
      `in msg from=999 chat=private type=text len=${SECRET.length} no-session`,
      `in msg from=5 @x chat=supergroup type=text len=${SECRET.length} ignored-group`,
    ])
    const p = setup({ status: 'pending' })
    await p.tg.onMessage(msg())
    const l = setup({ status: 'lost' })
    await l.tg.onMessage(msg())
    const s = setup()
    await s.tg.onMessage(msg({ text: '/stop' }))
    expect(lines.slice(2)).toEqual([
      `in msg from=42 @alexiapost chat=private type=text len=${SECRET.length} pending guest-task (s1)`,
      `in msg from=42 @alexiapost chat=private type=text len=${SECRET.length} lost guest-task (s1)`,
      'in msg from=42 @alexiapost chat=private type=text len=5 stop guest-task (s1)',
    ])
    noSecret()
  })

  it('voice and document: type logged, transcription and file name are not', async () => {
    const media: MediaHandler = { toEvent: async () => ({ content: `[голосовое, расшифровка] ${SECRET}`, meta: { audio_path: '/x/секрет.ogg', file_name: 'секрет.pdf' } }) }
    const { tg } = setup({ media })
    await tg.onMessage(msg({ text: undefined, voice: { file_id: 'v' } }))
    await tg.onMessage(msg({ text: undefined, caption: SECRET, document: { file_id: 'd', file_name: 'секрет.pdf' } }))
    expect(lines).toEqual([
      'in msg from=42 @alexiapost chat=private type=voice len=0 -> guest-task (s1)',
      `in msg from=42 @alexiapost chat=private type=document len=${SECRET.length} -> guest-task (s1)`,
    ])
    noSecret()
  })

  it('text verdict and button decisions', async () => {
    const { tg } = setup()
    const req = { request_id: 'abcde', tool_name: 'Bash', description: SECRET, input_preview: SECRET }
    await tg.askPermission('42', 's1', req)
    await tg.onMessage(msg({ text: 'yes abcde' }))
    await tg.askPermission('42', 's1', { ...req, request_id: 'fghij' })
    const answer = async () => {}
    await tg.onCallback({ id: 'q', from: { id: 999, username: 'evil' }, data: 'perm:allow:fghij' }, answer)
    await tg.onCallback({ id: 'q', from: { id: 42, username: 'alexiapost' }, data: 'perm:more:fghij' }, answer)
    await tg.onCallback({ id: 'q', from: { id: 42, username: 'alexiapost' }, data: 'perm:deny:fghij' }, answer)
    await tg.onCallback({ id: 'q', from: { id: 42 }, data: 'perm:allow:zzzzz' }, answer)
    expect(lines).toEqual([
      'out permission s1 abcde ok',
      'in msg from=42 @alexiapost chat=private type=text len=9 verdict abcde allow guest-task (s1)',
      'out permission s1 fghij ok',
      'in cb from=999 @evil perm:allow:fghij not-authorized',
      'in cb from=42 @alexiapost perm:more:fghij more guest-task (s1)',
      'in cb from=42 @alexiapost perm:deny:fghij verdict fghij deny guest-task (s1)',
      'in cb from=42 perm:allow:zzzzz stale',
    ])
    noSecret()
  })
})

describe('outbound log', () => {
  const route = { sessionId: 's1', sessionName: 'guest-task', headId: 'h', tgUsername: 'alexiapost', tgUserId: '42' }

  async function api(out: Outbound, lostGraceMs = 1000) {
    const store = new RouteStore(join(mkdtempSync(join(tmpdir(), 'td-log-')), 'routes.json'))
    const server = createApi({ store, hub: new Hub(), out, token: 't', lostGraceMs })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const call = (path: string, body: unknown) => fetch(url + path, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { store, server, call, url }
  }

  it('reply and edit: chunks, files, telegram error code, no text', async () => {
    const store0 = new RouteStore(join(mkdtempSync(join(tmpdir(), 'td-log-')), 'routes.json'))
    const ok = createTelegram({ bot: botStub(), store: store0, hub: hubStub(true), media: { toEvent: async () => undefined }, adminUserId: '1' })
    const { server, call } = await api(ok)
    try {
      await call('/routes', route)
      lines = []
      await call('/sessions/s1/reply', { text: SECRET + '\n' + 'x'.repeat(5000) })
      await call('/sessions/s1/edit', { message_id: '5', text: SECRET })
      expect(lines).toEqual(['out reply s1 chunks=3 files=0 ok', 'out edit s1 ok'])
    } finally {
      server.closeAllConnections()
      server.close()
    }
    const bad = createTelegram({ bot: botStub({ code: 403, description: 'Forbidden: bot was blocked by the user' }), store: store0, hub: hubStub(true), media: { toEvent: async () => undefined }, adminUserId: '1' })
    const b = await api(bad)
    try {
      await b.call('/routes', route)
      lines = []
      await b.call('/sessions/s1/reply', { text: SECRET })
      expect(lines).toEqual(['out reply s1 failed code=403 Forbidden: bot was blocked by the user'])
    } finally {
      b.server.closeAllConnections()
      b.server.close()
    }
    noSecret()
  })

  it('admin notifications: kind and result', async () => {
    const store = new RouteStore(join(mkdtempSync(join(tmpdir(), 'td-log-')), 'routes.json'))
    store.upsert(route, 0)
    store.setStatus('s1', 'active')
    store.touch('s1', 0)
    const bad = createTelegram({ bot: botStub({ code: 403, description: 'Forbidden: bot can\'t initiate conversation with a user' }), store, hub: hubStub(true), media: { toEvent: async () => undefined }, adminUserId: '1' })
    await checkIdle(store, bad, 25 * 3600_000, 24)
    expect(lines).toEqual([`admin idle s1 failed code=403 Forbidden: bot can't initiate conversation with a user`])

    lines = []
    const okTg = createTelegram({ bot: botStub(), store, hub: hubStub(true), media: { toEvent: async () => undefined }, adminUserId: '1' })
    await checkIdle(store, okTg, 26 * 3600_000, 24)
    expect(lines).toEqual(['admin idle s1 ok'])
  })

  it('lost and moved admin notices are logged', async () => {
    const okTg = createTelegram({ bot: botStub(), store: new RouteStore(join(mkdtempSync(join(tmpdir(), 'td-log-')), 'r.json')), hub: hubStub(true), media: { toEvent: async () => undefined }, adminUserId: '1' })
    const { store, server, call, url } = await api(okTg, 30)
    try {
      await call('/routes', route)
      store.setStatus('s1', 'active')
      await call('/routes', { ...route, sessionId: 's2', sessionName: 'next' })
      await new Promise(r => setTimeout(r, 30))
      expect(lines).toContain('admin moved s1 -> s2 ok')
      store.upsert({ ...route, sessionId: 's3', tgUsername: 'other', tgUserId: '77' }, 0)
      const ac = new AbortController()
      const res = await fetch(url + '/sessions/s3/events', { headers: { authorization: 'Bearer t' }, signal: ac.signal })
      expect(res.status).toBe(200)
      ac.abort()
      await new Promise(r => setTimeout(r, 100))
      expect(lines).toContain('session s3 connected')
      expect(lines).toContain('session s3 disconnected')
      expect(lines).toContain('session s3 lost')
      expect(lines).toContain('admin lost s3 ok')
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})
