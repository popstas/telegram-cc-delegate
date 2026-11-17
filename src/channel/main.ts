// telegram-delegate channel server: stdio MCP server started by Claude Code in a delegated session.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { configDirFrom } from '../config.ts'
import { createRouterClient } from './router-client.ts'
import { createChannelServer } from './server.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fail(msg: string): never {
  process.stderr.write(`telegram-delegate channel: ${msg}\n`)
  process.exit(1)
}

const sessionId = process.env.TD_SESSION_ID ?? ''
if (!UUID.test(sessionId)) fail('TD_SESSION_ID не задан или не uuid')
const url = process.env.TD_ROUTER_URL || 'http://127.0.0.1:8790'
const tokenFile = process.env.TD_TOKEN_FILE || join(configDirFrom(), 'api-token')
let token: string
try {
  token = readFileSync(tokenFile, 'utf8').trim()
} catch {
  fail(`не читается токен роутера ${tokenFile}`)
}
if (!token) fail(`пустой токен роутера ${tokenFile}`)

const ac = new AbortController()
const server = createChannelServer(createRouterClient({ url, token, sessionId }), { signal: ac.signal })

let exiting = false
function exit(): void {
  if (exiting) return
  exiting = true
  ac.abort()
  server.close().catch(() => {}).finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}
// Claude Code closes stdin when the session ends: the subscription drops, the router marks the route.
process.stdin.on('end', exit)
process.stdin.on('close', exit)
process.on('SIGTERM', exit)
process.on('SIGINT', exit)

await server.connect(new StdioServerTransport())
