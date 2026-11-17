import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  adminUserId: string
  port: number
  idleHours: number
  lostGraceSec: number
  deepgram: { language: string; model?: string }
  botToken?: string
  deepgramKey?: string
  stateDir: string
  configDir: string
}

const DEFAULTS = {
  adminUserId: '241225329',
  port: 8790,
  idleHours: 24,
  lostGraceSec: 60,
  deepgram: { language: 'ru' },
}

export function configDirFrom(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || homedir()
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'telegram-delegate')
}

export function stateDirFrom(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || homedir()
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'telegram-delegate')
}

/** Minimal KEY=VALUE parser: comments, blank lines, optional quotes, optional `export`. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2]!
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]!] = v
  }
  return out
}

/** config.json + .env from the config dir; real environment variables win over .env. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const configDir = configDirFrom(env)
  const stateDir = stateDirFrom(env)
  const cfgFile = join(configDir, 'config.json')
  const file = existsSync(cfgFile) ? (JSON.parse(readFileSync(cfgFile, 'utf8')) as Partial<Config>) : {}
  const envFile = join(configDir, '.env')
  const dotenv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}
  const pick = (k: string): string | undefined => env[k] || dotenv[k] || undefined
  return {
    adminUserId: String(file.adminUserId ?? DEFAULTS.adminUserId),
    port: Number(file.port ?? DEFAULTS.port),
    idleHours: Number(file.idleHours ?? DEFAULTS.idleHours),
    lostGraceSec: Number(file.lostGraceSec ?? DEFAULTS.lostGraceSec),
    deepgram: { ...DEFAULTS.deepgram, ...(file.deepgram ?? {}) },
    botToken: pick('TELEGRAM_BOT_TOKEN'),
    deepgramKey: pick('DEEPGRAM_API_KEY'),
    stateDir,
    configDir,
  }
}

/** Reads `<configDir>/api-token`, or creates it (32 random bytes, hex, mode 600). */
export function ensureApiToken(configDir: string): string {
  const file = join(configDir, 'api-token')
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim()
    if (t) return t
  }
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const token = randomBytes(32).toString('hex')
  writeFileSync(file, token + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
  return token
}
