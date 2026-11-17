import { CliError } from './api.ts'

export const CHANNEL = 'server:telegram-delegate'

export type Guest = { tgUsername: string } | { tgUserId: string }

/** --user: digits = Telegram user id, otherwise a username (5-32 chars, @ optional, stored lowercase without @). */
export function guestOf(user: unknown): Guest {
  if (typeof user !== 'string' || !user) throw new CliError('--user <@username|numeric id> is required')
  if (/^\d{1,20}$/.test(user)) return { tgUserId: user }
  const m = /^@?([A-Za-z][A-Za-z0-9_]{4,31})$/.exec(user)
  if (!m) throw new CliError(`--user: not a Telegram @username or numeric id: ${user}`)
  return { tgUsername: m[1]!.toLowerCase() }
}

export function guestLabelOf(g: { tgUsername?: string; tgUserId?: string }): string {
  return g.tgUsername ? `@${g.tgUsername}` : String(g.tgUserId)
}

export function sameGuest(r: { tgUsername?: string; tgUserId?: string }, g: Guest): boolean {
  if ('tgUserId' in g) return String(r.tgUserId ?? '') === g.tgUserId
  return (r.tgUsername ?? '').replace(/^@/, '').toLowerCase() === g.tgUsername
}

export function defaultName(g: Guest): string {
  return `telegram-delegate-${'tgUsername' in g ? g.tgUsername : g.tgUserId}`
}

export function mcpConfigOf(o: { sessionId: string; nodePath: string; channelMain: string; routerUrl: string; tokenFile: string }) {
  return {
    mcpServers: {
      'telegram-delegate': {
        command: o.nodePath,
        args: [o.channelMain],
        env: { TD_SESSION_ID: o.sessionId, TD_ROUTER_URL: o.routerUrl, TD_TOKEN_FILE: o.tokenFile },
      },
    },
  }
}

/** `--` ends the variadic --dangerously-load-development-channels, so a prompt is never taken for a server. */
export function claudeArgvOf(o: { sessionId: string; name: string; mcpFile: string; prompt?: string }): string[] {
  const argv = ['--session-id', o.sessionId, '-n', o.name, '--mcp-config', o.mcpFile, '--dangerously-load-development-channels', CHANNEL]
  if (o.prompt) argv.push('--', o.prompt)
  return argv
}

/**
 * Router answer (GET /known or POST /routes) + --write-first/--no-write-first -> whether the agent writes first.
 * The flags override the router's config.writeFirst; without a known guest id it is always false.
 */
export function writeFirstOf(data: { canWriteFirst?: unknown; writeFirst?: unknown } | undefined, wanted: boolean | undefined) {
  const canWriteFirst = data?.canWriteFirst === true
  const writeFirst = canWriteFirst && (wanted ?? data?.writeFirst === true)
  return { canWriteFirst, writeFirst, ignoredFlag: wanted === true && !canWriteFirst }
}

export const WRITE_FIRST_SECTION = `

## First message to the guest

Write to the guest first with the reply tool: who you are, what the task is and what you need from them. Keep it short. If reply returns an error (Telegram 403: the guest has not pressed Start or has blocked the bot), do not retry: tell the person in this terminal.
`

export function promptOf(task: string | undefined, writeFirst: boolean): string | undefined {
  if (task === undefined) return undefined
  return writeFirst ? task.replace(/\s*$/, '') + WRITE_FIRST_SECTION : task
}
