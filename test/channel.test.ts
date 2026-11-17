import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createRouterClient } from '../src/channel/router-client.ts'
import { createChannelServer } from '../src/channel/server.ts'

const TOKEN = 'tok'
const SID = '11111111-2222-4333-8444-555555555555'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void

/** Fake router: records requests, holds SSE connections, answers via a per-test handler. */
class FakeRouter {
  server!: http.Server
  port = 0
  requests: Array<{ method: string; url: string; auth?: string; body: string }> = []
  sse: http.ServerResponse[] = []
  eventsAttempts = 0
  events404 = 0
  replyStatus = 200
  replyBody: unknown = { message_ids: ['100'] }
  handler?: Handler

  async start(port = 0): Promise<this> {
    this.server = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', () => {
        this.requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body })
        if (this.handler) return this.handler(req, res, body)
        if (req.url === `/sessions/${SID}/events`) {
          this.eventsAttempts++
          if (this.events404 > 0) {
            this.events404--
            res.writeHead(404, { 'content-type': 'application/json' })
            return res.end('{"error":"route not found"}')
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(': connected\n\n')
          this.sse.push(res)
          return
        }
        if (req.url === `/sessions/${SID}/reply`) {
          res.writeHead(this.replyStatus, { 'content-type': 'application/json' })
          return res.end(JSON.stringify(this.replyBody))
        }
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    await new Promise<void>(r => this.server.listen(port, '127.0.0.1', r))
    this.port = (this.server.address() as AddressInfo).port
    return this
  }

  push(ev: unknown): void {
    for (const s of this.sse) s.write(`data: ${JSON.stringify(ev)}\n\n`)
  }

  async stop(): Promise<void> {
    for (const s of this.sse) s.destroy()
    this.sse = []
    this.server.closeAllConnections()
    await new Promise<void>(r => this.server.close(() => r()))
  }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout')
    await sleep(5)
  }
}

const channelNote = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
})
const permissionNote = z.object({
  method: z.literal('notifications/claude/channel/permission'),
  params: z.object({ request_id: z.string(), behavior: z.string() }),
})

async function setup(router?: FakeRouter) {
  const fake = router ?? await new FakeRouter().start()
  cleanups.push(() => fake.stop())
  const ac = new AbortController()
  cleanups.push(() => ac.abort())
  const rc = createRouterClient({ url: `http://127.0.0.1:${fake.port}`, token: TOKEN, sessionId: SID, minDelayMs: 20, maxDelayMs: 100 })
  const server = createChannelServer(rc, { signal: ac.signal })
  const client = new Client({ name: 'test', version: '0' })
  const channel: Array<{ content: string; meta: Record<string, string> }> = []
  const perms: Array<{ request_id: string; behavior: string }> = []
  client.setNotificationHandler(channelNote, n => { channel.push(n.params) })
  client.setNotificationHandler(permissionNote, n => { perms.push(n.params) })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  await client.connect(ct)
  cleanups.push(() => client.close())
  return { fake, server, client, channel, perms }
}

describe('channel server', () => {
  it('declares channel and permission capabilities', async () => {
    const { client } = await setup()
    const caps = client.getServerCapabilities()
    expect(caps?.experimental).toEqual({ 'claude/channel': {}, 'claude/channel/permission': {} })
    expect(caps?.tools).toBeDefined()
    expect(client.getInstructions()).toContain('<channel source="telegram-delegate"')
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name).sort()).toEqual(['edit_message', 'reply'])
  })

  it('router message becomes channel notification', async () => {
    const { fake, channel } = await setup()
    await until(() => fake.sse.length === 1)
    expect(fake.requests[0]!.auth).toBe(`Bearer ${TOKEN}`)
    fake.push({ type: 'message', content: 'привет', meta: { user_id: '42', kind: 'guest', 'bad-key': 'x' } })
    await until(() => channel.length === 1)
    expect(channel[0]!.content).toBe('привет')
    expect(channel[0]!.meta.user_id).toBe('42')
    expect(channel[0]!.meta['bad-key']).toBeUndefined()
  })

  it('router permission verdict becomes permission notification', async () => {
    const { fake, perms } = await setup()
    await until(() => fake.sse.length === 1)
    fake.push({ type: 'permission', request_id: 'abcde', behavior: 'deny' })
    await until(() => perms.length === 1)
    expect(perms[0]).toEqual({ request_id: 'abcde', behavior: 'deny' })
  })

  it('permission_request forwarded to router', async () => {
    const { fake, client } = await setup()
    await client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: { request_id: 'abcde', tool_name: 'Bash', description: 'run ls', input_preview: '{}' },
    } as never)
    await until(() => fake.requests.some(r => r.url === `/sessions/${SID}/permission`))
    const r = fake.requests.find(r => r.url === `/sessions/${SID}/permission`)!
    expect(r.method).toBe('POST')
    expect(JSON.parse(r.body).request_id).toBe('abcde')
  })

  it('reply tool posts to router', async () => {
    const { fake, client } = await setup()
    const res = await client.callTool({ name: 'reply', arguments: { text: 'ок', reply_to: '7' } })
    expect(res.isError).toBeFalsy()
    const r = fake.requests.find(r => r.url === `/sessions/${SID}/reply`)!
    expect(JSON.parse(r.body)).toEqual({ text: 'ок', reply_to: '7' })
    expect(JSON.stringify(res.content)).toContain('100')
  })

  it('reply tool passes buttons and enforces 8 x 64 limits', async () => {
    const { fake, client } = await setup()
    const ok = await client.callTool({ name: 'reply', arguments: { text: 'выбор', buttons: ['A', 'B'] } })
    expect(ok.isError).toBeFalsy()
    expect(JSON.parse(fake.requests.find(r => r.url === `/sessions/${SID}/reply`)!.body)).toEqual({ text: 'выбор', buttons: ['A', 'B'] })
    const nine = await client.callTool({ name: 'reply', arguments: { text: 'выбор', buttons: Array.from({ length: 9 }, (_, i) => `v${i}`) } })
    expect(nine.isError).toBe(true)
    expect(JSON.stringify(nine.content)).toContain('не больше 8')
    const long = await client.callTool({ name: 'reply', arguments: { text: 'выбор', buttons: ['x'.repeat(65)] } })
    expect(long.isError).toBe(true)
    expect(JSON.stringify(long.content)).toContain('64')
    expect(fake.requests.filter(r => r.url === `/sessions/${SID}/reply`)).toHaveLength(1)
    const tools = await client.listTools()
    expect(JSON.stringify(tools.tools.find(t => t.name === 'reply')!.inputSchema)).toContain('buttons')
    expect(client.getInstructions()).toContain('kind="button"')
  })

  it('edit_message tool posts to router', async () => {
    const { fake, client } = await setup()
    const res = await client.callTool({ name: 'edit_message', arguments: { message_id: '5', text: 'готово' } })
    expect(res.isError).toBeFalsy()
    const r = fake.requests.find(r => r.url === `/sessions/${SID}/edit`)!
    expect(JSON.parse(r.body)).toEqual({ message_id: '5', text: 'готово' })
  })

  it('reply tool returns router error as isError', async () => {
    const fake = await new FakeRouter().start()
    fake.replyStatus = 409
    fake.replyBody = { error: 'гость ещё не писал боту' }
    const { client } = await setup(fake)
    const res = await client.callTool({ name: 'reply', arguments: { text: 'ок' } })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('гость ещё не писал боту')
  })

  it('reconnects after router restart', async () => {
    const fake = await new FakeRouter().start()
    const port = fake.port
    const { channel } = await setup(fake)
    await until(() => fake.sse.length === 1)
    await fake.stop()
    await sleep(50)
    await fake.start(port)
    await until(() => fake.sse.length === 1)
    fake.push({ type: 'message', content: 'после рестарта', meta: { kind: 'guest' } })
    await until(() => channel.length === 1)
    expect(channel[0]!.content).toBe('после рестарта')
  })

  it('waits for route on 404', async () => {
    const fake = await new FakeRouter().start()
    fake.events404 = 2
    const { channel } = await setup(fake)
    await until(() => fake.sse.length === 1)
    expect(fake.eventsAttempts).toBe(3)
    fake.push({ type: 'message', content: 'дошло', meta: { kind: 'guest' } })
    await until(() => channel.length === 1)
  })
})

describe('channel main', () => {
  const run = (env: NodeJS.ProcessEnv, closeStdin: boolean) =>
    new Promise<{ code: number | null; stderr: string }>(resolve => {
      const p = spawn(process.execPath, ['src/channel/main.ts'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
      let stderr = ''
      p.stderr.on('data', d => (stderr += d))
      p.on('exit', code => resolve({ code, stderr }))
      if (closeStdin) setTimeout(() => p.stdin.end(), 300)
      setTimeout(() => p.kill('SIGKILL'), 5000)
    })

  it('exits 1 without TD_SESSION_ID', async () => {
    const r = await run({}, false)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('TD_SESSION_ID')
  })

  it('exits 0 on stdin EOF', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'td-ch-'))
    writeFileSync(join(dir, 'api-token'), 'tok\n')
    const r = await run({ TD_SESSION_ID: SID, TD_TOKEN_FILE: join(dir, 'api-token'), TD_ROUTER_URL: 'http://127.0.0.1:1' }, true)
    expect(r.code).toBe(0)
  })

  it('main.ts over stdio delivers a router event as channel notification and exits 0 on close', async () => {
    const fake = await new FakeRouter().start()
    cleanups.push(() => fake.stop())
    const dir = mkdtempSync(join(tmpdir(), 'td-ch-'))
    writeFileSync(join(dir, 'api-token'), `${TOKEN}\n`)
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['src/channel/main.ts'],
      env: { PATH: process.env.PATH ?? '', HOME: dir, TD_SESSION_ID: SID, TD_TOKEN_FILE: join(dir, 'api-token'), TD_ROUTER_URL: `http://127.0.0.1:${fake.port}` },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'stdio-test', version: '0' })
    const got: Array<{ content: string; meta: Record<string, string> }> = []
    client.setNotificationHandler(channelNote, n => { got.push(n.params) })
    await client.connect(transport)
    const pid = transport.pid!
    expect(client.getServerCapabilities()?.experimental).toEqual({ 'claude/channel': {}, 'claude/channel/permission': {} })
    await until(() => fake.sse.length === 1, 5000)
    expect(fake.requests[0]!.auth).toBe(`Bearer ${TOKEN}`)
    fake.push({ type: 'message', content: 'по stdio', meta: { user_id: '42', kind: 'guest' } })
    await until(() => got.length === 1, 5000)
    expect(got[0]).toEqual({ content: 'по stdio', meta: { user_id: '42', kind: 'guest' } })
    await client.close()
    // StdioClientTransport closes stdin first; the server must exit by itself.
    await until(() => { try { process.kill(pid, 0); return false } catch { return true } }, 5000)
  })
})
