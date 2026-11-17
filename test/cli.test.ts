import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setLogSink, type LogSink } from '../src/log.ts'
import { createApi } from '../src/router/api.ts'
import { Hub } from '../src/router/hub.ts'
import type { Outbound } from '../src/router/types.ts'
import { RouteStore } from '../src/routes.ts'
import { claudeArgvOf, guestOf, promptOf, WRITE_FIRST_SECTION, writeFirstOf } from '../src/cli/plan.ts'

const CLI = resolve(import.meta.dirname, '../src/cli/main.ts')
const CHANNEL_MAIN = resolve(import.meta.dirname, '../src/channel/main.ts')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Fake claude: records argv and the MCP config it was given, then exits or waits for a signal. */
const FAKE_CLAUDE = `#!${process.execPath}
const fs = require('node:fs')
const argv = process.argv.slice(2)
const mcp = argv[argv.indexOf('--mcp-config') + 1]
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ argv, mcp: fs.readFileSync(mcp, 'utf8') }))
if (process.env.FAKE_MODE === 'connect') {
  // Like the channel server: subscribe, so the route is active and a drop would arm the lost timer.
  const e = JSON.parse(fs.readFileSync(mcp, 'utf8')).mcpServers['telegram-delegate'].env
  const ac = new AbortController()
  fetch(e.TD_ROUTER_URL + '/sessions/' + e.TD_SESSION_ID + '/events', { headers: { authorization: 'Bearer ' + fs.readFileSync(e.TD_TOKEN_FILE, 'utf8').trim() }, signal: ac.signal })
    .then(r => { fs.writeFileSync(process.env.FAKE_OUT + '.sse', String(r.status)); setTimeout(() => { ac.abort(); process.exit(0) }, 100) })
} else if (process.env.FAKE_MODE === 'wait') {
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))
  setInterval(() => {}, 1000)
} else process.exit(Number(process.env.FAKE_CODE ?? 0))
`

type Run = { code: number | null; stdout: string; stderr: string }
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
let prevSink: LogSink
beforeAll(() => { prevSink = setLogSink(() => {}) })
afterAll(() => { setLogSink(prevSink) })

async function setup(opts: { writeFirst?: boolean; lostGraceMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'td-cli-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  const tokenFile = join(root, 'api-token')
  writeFileSync(tokenFile, 'tok\n')
  const store = new RouteStore(join(root, 'routes.json'))
  const admin: string[] = []
  const out = {
    botUsername: () => 'td_test_bot',
    notifyAdmin: async (t: string) => { admin.push(t) },
    sendText: async () => [], sendFiles: async () => [], editText: async () => {}, askPermission: async () => {},
  } as unknown as Outbound
  const known = { has: (id: string) => id === '42', idByUsername: (u?: string) => (u === 'knownguest' ? '42' : undefined) }
  const server = createApi({ store, hub: new Hub(), out, token: 'tok', lostGraceMs: opts.lostGraceMs ?? 50, known, writeFirst: opts.writeFirst })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  cleanups.push(() => server.close())
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const fakeOut = join(root, 'claude.json')
  const env = {
    HOME: root, XDG_CONFIG_HOME: join(root, 'cfg'), XDG_STATE_HOME: join(root, 'state'),
    TD_ROUTER_URL: url, TD_TOKEN_FILE: tokenFile, PATH: bin, FAKE_OUT: fakeOut,
  }
  const run = (args: string[], o: { env?: Record<string, string>; onStart?: (pid: number) => void } = {}) =>
    new Promise<Run>(done => {
      const p = spawn(process.execPath, [CLI, ...args], { env: { ...env, ...o.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      p.stdout.on('data', d => { stdout += d })
      p.stderr.on('data', d => { stderr += d })
      p.on('exit', code => done({ code, stdout, stderr }))
      o.onStart?.(p.pid!)
    })
  const claudeCall = () => JSON.parse(readFileSync(fakeOut, 'utf8')) as { argv: string[]; mcp: string }
  const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise(r => setTimeout(r, 25)) }
  return { root, store, admin, url, tokenFile, env, run, claudeCall, fakeOut, until }
}

describe('cli plan', () => {
  it('argv ends the channel list with -- before the prompt', () => {
    expect(claudeArgvOf({ sessionId: 's', name: 'n', mcpFile: 'm.json', prompt: '- list item' })).toEqual([
      '--session-id', 's', '-n', 'n', '--mcp-config', 'm.json', '--dangerously-load-development-channels', 'server:telegram-delegate', '--', '- list item',
    ])
    expect(claudeArgvOf({ sessionId: 's', name: 'n', mcpFile: 'm.json' }).at(-1)).toBe('server:telegram-delegate')
  })

  it('guest, writeFirst flags and prompt', () => {
    expect(guestOf('@Some_User')).toEqual({ tgUsername: 'some_user' })
    expect(guestOf('1001')).toEqual({ tgUserId: '1001' })
    expect(() => guestOf('a b')).toThrow(/not a Telegram/)
    expect(writeFirstOf({ canWriteFirst: true, writeFirst: false }, true)).toMatchObject({ writeFirst: true })
    expect(writeFirstOf({ canWriteFirst: true, writeFirst: true }, false)).toMatchObject({ writeFirst: false })
    expect(writeFirstOf({ canWriteFirst: true, writeFirst: true }, undefined)).toMatchObject({ writeFirst: true })
    expect(writeFirstOf({ canWriteFirst: false, writeFirst: true }, true)).toEqual({ canWriteFirst: false, writeFirst: false, ignoredFlag: true })
    expect(promptOf('task\n\n', true)).toBe(`task${WRITE_FIRST_SECTION}`)
    expect(WRITE_FIRST_SECTION).not.toMatch(/head/)
    expect(promptOf('task', false)).toBe('task')
    expect(promptOf(undefined, true)).toBeUndefined()
  })
})

describe('telegram-delegate start', () => {
  it('creates the route, runs claude with the MCP config and closes the route on exit', async () => {
    const t = await setup()
    writeFileSync(join(t.root, 'task.md'), 'Review the report with the guest.\n')
    const r = await t.run(['start', '--user', '@NewGuest', '--task-file', join(t.root, 'task.md')], { env: { FAKE_CODE: '3' } })
    expect(r.code).toBe(3)
    const { argv, mcp } = t.claudeCall()
    const sid = argv[1]!
    expect(sid).toMatch(UUID)
    const mcpFile = join(t.root, 'state', 'telegram-delegate', 'mcp', `${sid}.json`)
    expect(argv).toEqual(['--session-id', sid, '-n', 'telegram-delegate-newguest', '--mcp-config', mcpFile,
      '--dangerously-load-development-channels', 'server:telegram-delegate', '--', 'Review the report with the guest.\n'])
    expect(JSON.parse(mcp)).toEqual({
      mcpServers: { 'telegram-delegate': { command: process.execPath, args: [CHANNEL_MAIN], env: { TD_SESSION_ID: sid, TD_ROUTER_URL: t.url, TD_TOKEN_FILE: t.tokenFile } } },
    })
    expect(existsSync(mcpFile)).toBe(false)
    expect(t.store.get(sid)).toMatchObject({ status: 'closed', sessionName: 'telegram-delegate-newguest', headId: '', tgUsername: 'newguest' })
    expect(t.admin).toEqual([])
    expect(r.stderr).toContain('press Enter')
    expect(r.stderr).toContain('has not written to the bot yet')
  })

  it('writeFirst: the router config, overridden by the flags', async () => {
    const t = await setup({ writeFirst: true })
    writeFileSync(join(t.root, 'task.md'), 'Task.')
    expect((await t.run(['start', '--user', 'knownguest', '--task-file', join(t.root, 'task.md'), '--name', 'my-task'])).code).toBe(0)
    let { argv } = t.claudeCall()
    expect(argv[3]).toBe('my-task')
    expect(argv.at(-1)).toBe(`Task.${WRITE_FIRST_SECTION}`)
    expect(t.store.get(argv[1]!)).toMatchObject({ tgUserId: '42', status: 'closed' })

    expect((await t.run(['start', '--user', 'knownguest', '--task-file', join(t.root, 'task.md'), '--no-write-first'])).code).toBe(0)
    ;({ argv } = t.claudeCall())
    expect(argv.at(-1)).toBe('Task.')

    const t2 = await setup({ writeFirst: false })
    writeFileSync(join(t2.root, 'task.md'), 'Task.')
    expect((await t2.run(['start', '--user', '42', '--task-file', join(t2.root, 'task.md'), '--write-first'])).code).toBe(0)
    expect(t2.claudeCall().argv.at(-1)).toBe(`Task.${WRITE_FIRST_SECTION}`)
  })

  it('Ctrl+C in the terminal: claude exits, the route is closed, exit code is claude\'s', async () => {
    const t = await setup()
    let pid = 0
    const done = t.run(['start', '--user', '@sigguest'], { env: { FAKE_MODE: 'wait' }, onStart: p => { pid = p } })
    await t.until(() => existsSync(t.fakeOut))
    const sid = t.claudeCall().argv[1]!
    expect(t.store.get(sid)?.status).toBe('pending')
    expect(t.claudeCall().argv.at(-1)).toBe('server:telegram-delegate')
    process.kill(-pid, 'SIGINT') // the terminal signals the whole foreground group
    const r = await done
    expect(r.code).toBe(130)
    expect(t.store.get(sid)?.status).toBe('closed')
  })

  it('SIGTERM to the command is forwarded to claude and the route is closed', async () => {
    const t = await setup()
    let pid = 0
    const done = t.run(['start', '--user', '@termguest'], { env: { FAKE_MODE: 'wait' }, onStart: p => { pid = p } })
    await t.until(() => existsSync(t.fakeOut))
    const sid = t.claudeCall().argv[1]!
    process.kill(pid, 'SIGTERM')
    const r = await done
    expect(r.code).toBe(143)
    expect(t.store.get(sid)?.status).toBe('closed')
  })

  it('claude not in PATH: the route is closed again', async () => {
    const t = await setup()
    const r = await t.run(['start', '--user', '@noclaude'], { env: { PATH: join(t.root, 'empty') } })
    expect(r.code).toBe(127)
    expect(r.stderr).toContain('claude not found in PATH')
    const routes = t.store.list()
    expect(routes).toHaveLength(1)
    expect(routes[0]!.status).toBe('closed')
  })

  it('router down: clear error, claude is not started', async () => {
    const t = await setup()
    const r = await t.run(['start', '--user', '@guest_down'], { env: { TD_ROUTER_URL: 'http://127.0.0.1:1' } })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('router is not reachable at http://127.0.0.1:1')
    expect(existsSync(t.fakeOut)).toBe(false)
  })

  it('guest with another open session: warning about the move', async () => {
    const t = await setup()
    t.store.upsert({ sessionId: 'old', sessionName: 'old-task', headId: '', tgUsername: 'mover' }, 0)
    const r = await t.run(['start', '--user', '@mover'])
    expect(r.code).toBe(0)
    expect(r.stderr).toMatch(/warning: @mover had an open route to session old-task \(old\)/)
  })

  it('--dry-run prints the plan and creates nothing', async () => {
    const t = await setup()
    t.store.upsert({ sessionId: 'old', sessionName: 'old-task', headId: '', tgUsername: 'knownguest' }, 0)
    writeFileSync(join(t.root, 'task.md'), 'Task.')
    const r = await t.run(['start', '--user', '@knownguest', '--task-file', join(t.root, 'task.md'), '--write-first', '--dry-run'])
    expect(r.code).toBe(0)
    const plan = JSON.parse(r.stdout)
    expect(plan).toMatchObject({
      dryRun: true, botUsername: 'td_test_bot', canWriteFirst: true, writeFirst: true,
      post: { path: '/routes', body: { sessionName: 'telegram-delegate-knownguest', headId: '', tgUsername: 'knownguest' } },
      wouldMove: { sessionId: 'old' },
    })
    expect(plan.claude.slice(0, 2)).toEqual(['claude', '--session-id'])
    expect(plan.claude.at(-1)).toBe(`Task.${WRITE_FIRST_SECTION}`)
    expect(plan.mcpConfig.mcpServers['telegram-delegate'].env.TD_SESSION_ID).toBe(plan.post.body.sessionId)
    expect(t.store.list().map(x => x.sessionId)).toEqual(['old'])
    expect(existsSync(plan.mcpFile)).toBe(false)
    expect(existsSync(t.fakeOut)).toBe(false)
  })

  it('usage errors', async () => {
    const t = await setup()
    expect((await t.run(['start'])).stderr).toContain('--user <@username|numeric id> is required')
    expect((await t.run(['start', '--user', '@guest_x', '--bogus'])).code).toBe(2)
    expect((await t.run(['start', '--user', '@guest_x', '--task-file', join(t.root, 'nope.md')])).stderr).toContain('cannot read --task-file')
    expect(t.store.list()).toEqual([])
  })
})

describe('telegram-delegate start: no lost notice', () => {
  it('an active session that ends with claude is closed, not lost', async () => {
    const t = await setup({ lostGraceMs: 300 })
    const r = await t.run(['start', '--user', '@liveguest'], { env: { FAKE_MODE: 'connect' } })
    expect(r.code).toBe(0)
    expect(readFileSync(t.fakeOut + '.sse', 'utf8')).toBe('200')
    const sid = t.claudeCall().argv[1]!
    await new Promise(res => setTimeout(res, 600))
    expect(t.store.get(sid)?.status).toBe('closed')
    expect(t.admin).toEqual([])
  })

  it('control: the same drop without the command becomes lost with a notice', async () => {
    const t = await setup({ lostGraceMs: 300 })
    t.store.upsert({ sessionId: 'raw', sessionName: 'raw-task', headId: '', tgUsername: 'liveguest' }, 0)
    const ac = new AbortController()
    const res = await fetch(`${t.url}/sessions/raw/events`, { headers: { authorization: 'Bearer tok' }, signal: ac.signal })
    expect(res.status).toBe(200)
    ac.abort()
    await new Promise(r => setTimeout(r, 600))
    expect(t.store.get('raw')?.status).toBe('lost')
    expect(t.admin).toEqual(['Session ended'])
  })
})

describe('telegram-delegate stop and status', () => {
  it('status lists open routes, stop closes them by user or session id', async () => {
    const t = await setup()
    t.store.upsert({ sessionId: 'a', sessionName: 'task-a', headId: '', tgUsername: 'guest_a' }, 0)
    t.store.upsert({ sessionId: 'b', sessionName: 'task-b', headId: '', tgUserId: '77' }, 0)
    let r = await t.run(['status'])
    expect(r.stdout.trim().split('\n')).toEqual([
      'pending\t@guest_a\ttask-a\ta\tlast=-',
      'pending\t77\ttask-b\tb\tlast=-',
    ])
    r = await t.run(['stop', '--user', '@Guest_A'])
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('closed task-a (a) @guest_a')
    expect((await t.run(['stop', '--session-id', 'b'])).code).toBe(0)
    expect((await t.run(['status'])).stdout.trim()).toBe('no open routes')
    expect((await t.run(['status', '--all'])).stdout.trim().split('\n')).toHaveLength(2)
    r = await t.run(['stop', '--user', '@guest_a'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('@guest_a has no open route')
  })
})
