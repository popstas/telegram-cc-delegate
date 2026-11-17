import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDirFrom } from '../config.ts'

/** Router API from the CLI side: admin routes (/health, /routes, /known), Bearer from the api-token file. */
export interface AdminApi {
  url: string
  tokenFile: string
  call(method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, any> }>
}

export class CliError extends Error {}

/** TD_ROUTER_URL, or 127.0.0.1 with the port from config.json (8790 by default). */
export function routerUrlFrom(env: NodeJS.ProcessEnv): string {
  if (env.TD_ROUTER_URL) return env.TD_ROUTER_URL.replace(/\/+$/, '')
  let port = 8790
  try {
    const cfg = JSON.parse(readFileSync(join(configDirFrom(env), 'config.json'), 'utf8')) as { port?: unknown }
    if (Number.isInteger(Number(cfg.port)) && Number(cfg.port) > 0) port = Number(cfg.port)
  } catch {}
  return `http://127.0.0.1:${port}`
}

export function createAdminApi(env: NodeJS.ProcessEnv, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): AdminApi {
  const url = routerUrlFrom(env)
  const tokenFile = env.TD_TOKEN_FILE || join(configDirFrom(env), 'api-token')
  const doFetch = opts.fetch ?? fetch
  let token: string | undefined
  const down = (why: string) => new CliError(`router is not reachable at ${url} (${why}): start it with "systemctl --user start telegram-delegate"`)

  return {
    url,
    tokenFile,
    async call(method, path, body) {
      if (token === undefined) {
        try {
          token = readFileSync(tokenFile, 'utf8').trim()
        } catch {
          token = ''
        }
        if (!token) throw down(`no api token in ${tokenFile}, the router creates it on the first start`)
      }
      let res: Response
      try {
        res = await doFetch(url + path, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
          ...(body !== undefined && { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
        })
      } catch (e) {
        const c = (e as { cause?: { code?: string } }).cause?.code
        throw down(c || (e instanceof Error ? e.name : String(e)))
      }
      let data: Record<string, any> = {}
      try {
        data = (await res.json()) as Record<string, any>
      } catch {}
      if (res.status === 401) throw new CliError(`router refused the token (401): ${tokenFile} does not match the router's api-token`)
      return { status: res.status, data }
    },
  }
}
