import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createRouterClient } from '../src/channel/router-client.ts'
import { createChannelServer } from '../src/channel/server.ts'
import { createApi } from '../src/router/api.ts'
import { Hub } from '../src/router/hub.ts'
import { createTelegram, type BotLike } from '../src/router/telegram.ts'
import { RouteStore } from '../src/routes.ts'

const SID = '11111111-2222-4333-8444-555555555555'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout')
    await sleep(5)
  }
}

describe('router + channel server end to end', () => {
  it('guest text -> session, reply -> guest, permission round trip', async () => {
    const store = new RouteStore(join(mkdtempSync(join(tmpdir(), 'td-e2e-')), 'routes.json'))
    const hub = new Hub()
    const sent: Array<{ chat: string; text: string; opts?: object }> = []
    let mid = 900
    const bot: BotLike = {
      api: {
        async sendMessage(chat, text, opts) { sent.push({ chat, text, opts }); return { message_id: ++mid } },
        async editMessageText() { return true },
        async sendDocument() { return { message_id: ++mid } },
        async sendPhoto() { return { message_id: ++mid } },
        async sendChatAction() { return true },
        async getMe() { return { username: 'td_bot' } },
      },
    }
    const tg = createTelegram({ bot, store, hub, media: { toEvent: async () => undefined }, adminUserId: '1' })
    const api = createApi({ store, hub, out: tg, token: 'tok', lostGraceMs: 1000 })
    await new Promise<void>(r => api.listen(0, '127.0.0.1', r))
    const port = (api.address() as AddressInfo).port

    const ac = new AbortController()
    const server = createChannelServer(
      createRouterClient({ url: `http://127.0.0.1:${port}`, token: 'tok', sessionId: SID, minDelayMs: 20, maxDelayMs: 50 }),
      { signal: ac.signal },
    )
    const client = new Client({ name: 'e2e', version: '0' })
    const inbox: Array<{ content: string; meta: Record<string, string> }> = []
    const verdicts: unknown[] = []
    client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }), n => { inbox.push(n.params) })
    client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel/permission'), params: z.object({ request_id: z.string(), behavior: z.string() }) }), n => { verdicts.push(n.params) })
    try {
      // Channel server starts before the route exists: it waits on 404.
      const [ct, st] = InMemoryTransport.createLinkedPair()
      await server.connect(st)
      await client.connect(ct)
      await sleep(60)
      store.upsert({ sessionId: SID, sessionName: 'guest-task', headId: 'h', tgUsername: 'alexiapost' }, Date.now())
      await until(() => store.get(SID)?.status === 'active' && hub.connected(SID))

      await tg.onMessage({ message_id: 7, date: 1_700_000_000, chat: { id: 42, type: 'private' }, from: { id: 42, username: 'alexiapost' }, text: 'привет' })
      await until(() => inbox.length === 1)
      expect(inbox[0]!.content).toBe('привет')
      expect(inbox[0]!.meta.user_id).toBe('42')

      const res = await client.callTool({ name: 'reply', arguments: { text: 'здравствуйте' } })
      expect(res.isError).toBeFalsy()
      expect(sent.at(-1)).toMatchObject({ chat: '42', text: 'здравствуйте' })

      await client.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'ls', input_preview: '{}' } } as never)
      await until(() => sent.some(s => s.text === 'Подтвердить: Bash - ls'))
      const answers: Array<string | undefined> = []
      await tg.onCallback({ id: 'q', from: { id: 7777 }, data: 'perm:allow:abcde' }, async t => { answers.push(t) })
      await tg.onCallback({ id: 'q', from: { id: 42 }, data: 'perm:allow:abcde' }, async t => { answers.push(t) })
      expect(answers[0]).toBe('Not authorized.')
      await until(() => verdicts.length === 1)
      expect(verdicts[0]).toEqual({ request_id: 'abcde', behavior: 'allow' })
    } finally {
      ac.abort()
      await client.close()
      hub.closeAll()
      api.closeAllConnections()
      api.close()
    }
  })
})
