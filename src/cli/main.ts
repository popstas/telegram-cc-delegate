#!/usr/bin/env node
// telegram-delegate CLI: start a delegated Claude Code session for a Telegram guest in this terminal, stop it, list routes.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { stateDirFrom } from '../config.ts'
import { CliError, createAdminApi, type AdminApi } from './api.ts'
import { claudeArgvOf, defaultName, guestLabelOf, guestOf, mcpConfigOf, promptOf, sameGuest, writeFirstOf } from './plan.ts'

const USAGE = `usage:
  telegram-delegate start --user <@username|id> [--task-file <file>] [--name <name>] [--write-first | --no-write-first] [--dry-run]
  telegram-delegate stop (--user <@username|id> | --session-id <uuid>)
  telegram-delegate status [--all]

start runs Claude Code in this terminal with the telegram-delegate channel bound to the guest
and closes the route when Claude Code exits. Env: TD_ROUTER_URL, TD_TOKEN_FILE, TD_CLAUDE (claude binary).`

const env = process.env
const say = (s: string) => process.stderr.write(`telegram-delegate: ${s}\n`)
const out = (s: string) => process.stdout.write(`${s}\n`)

class UsageError extends Error {}

function parse(args: string[], options: ParseArgsConfig['options']) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values as Record<string, string | boolean | undefined>
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e))
  }
}

async function health(api: AdminApi): Promise<string> {
  const h = await api.call('GET', '/health')
  if (h.status !== 200) throw new CliError(`router at ${api.url} answered GET /health ${h.status}`)
  return String(h.data.botUsername ?? '')
}

async function start(args: string[]): Promise<number> {
  const v = parse(args, {
    user: { type: 'string' },
    'task-file': { type: 'string' },
    name: { type: 'string' },
    'write-first': { type: 'boolean' },
    'no-write-first': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
  })
  const g = guestOf(v.user)
  if (v['write-first'] && v['no-write-first']) throw new UsageError('--write-first and --no-write-first exclude each other')
  const wanted = v['write-first'] ? true : v['no-write-first'] ? false : undefined
  let task: string | undefined
  if (typeof v['task-file'] === 'string') {
    try {
      task = readFileSync(v['task-file'], 'utf8')
    } catch (e) {
      throw new CliError(`cannot read --task-file ${v['task-file']}: ${(e as { code?: string }).code ?? e}`)
    }
    if (!task.trim()) throw new CliError(`--task-file ${v['task-file']} is empty`)
  }
  const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim() : defaultName(g)
  if (name.length > 200) throw new UsageError('--name: at most 200 characters')

  const api = createAdminApi(env)
  const botUsername = await health(api)
  const sessionId = randomUUID()
  const mcpFile = join(stateDirFrom(env), 'mcp', `${sessionId}.json`)
  const channelMain = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'channel', 'main.ts')
  const mcpConfig = mcpConfigOf({ sessionId, nodePath: process.execPath, channelMain, routerUrl: api.url, tokenFile: api.tokenFile })
  const route = { sessionId, sessionName: name, headId: '', ...g }
  const claude = env.TD_CLAUDE || 'claude'

  if (v['dry-run']) {
    const { data } = await api.call('GET', '/routes')
    const wouldMove = ((data.routes ?? []) as Array<Record<string, string>>).find(r => r.status !== 'closed' && sameGuest(r, g))
    const known = await api.call('GET', `/known?${new URLSearchParams(g as Record<string, string>)}`)
    const wf = writeFirstOf(known.status === 200 ? known.data : undefined, wanted)
    const argv = claudeArgvOf({ sessionId, name, mcpFile, prompt: promptOf(task, wf.writeFirst) })
    out(JSON.stringify({ dryRun: true, botUsername, post: { path: '/routes', body: route }, ...(wouldMove && { wouldMove }), ...wf, mcpFile, mcpConfig, claude: [claude, ...argv] }, null, 2))
    return 0
  }

  // From here a route may exist: a signal must not leave it open.
  let child: ReturnType<typeof spawn> | undefined
  let stopSignal: NodeJS.Signals | undefined
  let killTimer: NodeJS.Timeout | undefined
  const onSignal = (sig: NodeJS.Signals) => {
    stopSignal ??= sig
    // Ctrl+C reaches Claude Code from the terminal by itself (it cancels or asks to press again): not forwarded.
    if (!child || sig === 'SIGINT') return
    child.kill(sig)
    killTimer ??= setTimeout(() => child?.kill('SIGKILL'), 10_000)
  }
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const s of signals) process.on(s, onSignal)

  const reg = await api.call('POST', '/routes', route)
  if (reg.status !== 201 && reg.status !== 200) throw new CliError(`POST /routes: ${reg.status} ${reg.data.error ?? ''}`.trim())
  const close = async () => {
    rmSync(mcpFile, { force: true })
    try {
      const r = await api.call('DELETE', `/routes/${encodeURIComponent(sessionId)}`)
      if (r.status !== 200) say(`could not close route ${sessionId}: DELETE ${r.status} ${r.data.error ?? ''}`.trim())
      else say(`route ${sessionId} closed`)
    } catch (e) {
      say(`could not close route ${sessionId}: ${e instanceof Error ? e.message : e}; run "telegram-delegate stop --session-id ${sessionId}"`)
    }
  }
  if (stopSignal) {
    await close()
    return 128 + (constants.signals[stopSignal] ?? 0)
  }

  const moved = reg.data.moved as Record<string, string> | undefined
  if (moved) say(`warning: ${guestLabelOf(g)} had an open route to session ${moved.sessionName} (${moved.sessionId}); it is moved here and that session is told the guest left`)
  const wf = writeFirstOf(reg.data, wanted)
  if (wf.ignoredFlag) say('--write-first ignored: the bot does not know the guest\'s id yet (they have not written to the bot)')
  if (wf.writeFirst && task === undefined) say('writeFirst is on, but there is no --task-file: tell the agent yourself to write to the guest first')
  const prompt = promptOf(task, wf.writeFirst)

  try {
    mkdirSync(dirname(mcpFile), { recursive: true, mode: 0o700 })
    writeFileSync(mcpFile, `${JSON.stringify(mcpConfig, null, 2)}\n`, { mode: 0o600 })
  } catch (e) {
    await close()
    throw new CliError(`cannot write the MCP config ${mcpFile}: ${e instanceof Error ? e.message : e}`)
  }

  say(`session ${name} (${sessionId}) for ${guestLabelOf(g)}, bot @${botUsername}`)
  say(wf.canWriteFirst ? `the bot knows the guest; writeFirst=${wf.writeFirst}` : 'the guest has not written to the bot yet: ask them to open the bot, press Start and write')
  say('Claude Code will warn about development channels: press Enter to continue.')
  if (prompt === undefined) say('no --task-file: paste the task into Claude Code yourself.')

  const code = await new Promise<number>(done => {
    try {
      child = spawn(claude, claudeArgvOf({ sessionId, name, mcpFile, prompt }), { stdio: 'inherit' })
    } catch (e) {
      say(`cannot start ${claude}: ${e instanceof Error ? e.message : e}`)
      return done(127)
    }
    child.once('error', e => {
      const c = (e as { code?: string }).code
      say(c === 'ENOENT' ? `${claude} not found in PATH (set TD_CLAUDE to the claude binary)` : `cannot start ${claude}: ${e.message}`)
      done(127)
    })
    child.once('exit', (c, sig) => done(c ?? 128 + (sig ? constants.signals[sig] ?? 0 : 0)))
    if (stopSignal && stopSignal !== 'SIGINT') onSignal(stopSignal)
  })
  if (killTimer) clearTimeout(killTimer)
  await close()
  for (const s of signals) process.off(s, onSignal)
  return code
}

async function stop(args: string[]): Promise<number> {
  const v = parse(args, { user: { type: 'string' }, 'session-id': { type: 'string' } })
  const api = createAdminApi(env)
  let targets: string[]
  if (typeof v['session-id'] === 'string') targets = [v['session-id']]
  else if (v.user !== undefined) {
    const g = guestOf(v.user)
    const { data } = await api.call('GET', '/routes')
    targets = ((data.routes ?? []) as Array<Record<string, string>>).filter(r => r.status !== 'closed' && sameGuest(r, g)).map(r => r.sessionId!)
    if (!targets.length) throw new CliError(`${guestLabelOf(g)} has no open route`)
  } else throw new UsageError('stop: --user <@username|id> or --session-id <uuid>')
  for (const id of targets) {
    const r = await api.call('DELETE', `/routes/${encodeURIComponent(id)}`)
    if (r.status !== 200) throw new CliError(`DELETE /routes/${id}: ${r.status} ${r.data.error ?? ''}`.trim())
    out(`closed ${r.data.route?.sessionName ?? ''} (${id}) ${r.data.route ? guestLabelOf(r.data.route) : ''}`.replace(/\s+/g, ' ').trim())
  }
  return 0
}

async function status(args: string[]): Promise<number> {
  const v = parse(args, { all: { type: 'boolean' } })
  const api = createAdminApi(env)
  const r = await api.call('GET', '/routes')
  if (r.status !== 200) throw new CliError(`GET /routes: ${r.status}`)
  const routes = ((r.data.routes ?? []) as Array<Record<string, any>>).filter(x => v.all || x.status !== 'closed')
  if (!routes.length) out(v.all ? 'no routes' : 'no open routes')
  for (const x of routes) {
    const last = x.lastMessageAt ? new Date(x.lastMessageAt).toISOString() : '-'
    out(`${x.status}\t${guestLabelOf(x)}\t${x.sessionName}\t${x.sessionId}\tlast=${last}`)
  }
  return 0
}

const commands: Record<string, (args: string[]) => Promise<number>> = { start, stop, status }

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    out(USAGE)
    return cmd ? 0 : 2
  }
  const run = commands[cmd]
  if (!run) throw new UsageError(`unknown command ${cmd}`)
  return run(rest)
}

main().then(
  code => process.exit(code),
  e => {
    if (e instanceof UsageError) {
      say(e.message)
      process.stderr.write(`${USAGE}\n`)
      process.exit(2)
    }
    say(e instanceof CliError ? e.message : `error: ${e instanceof Error ? e.stack : e}`)
    process.exit(1)
  },
)
