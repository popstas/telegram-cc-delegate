import type { PermissionRequest, SessionEvent } from '../router/types.ts'

export interface RouterClient {
  /** SSE subscription with reconnect (1 s, x2, up to 30 s; also on 404 while the route is not created yet). Resolves on abort. */
  events(onEvent: (e: SessionEvent) => void, signal: AbortSignal): Promise<void>
  reply(a: { text: string; files?: string[]; reply_to?: string; buttons?: string[] }): Promise<string[]>
  edit(a: { message_id: string; text: string }): Promise<void>
  permission(r: PermissionRequest): Promise<void>
}

function log(msg: string): void {
  process.stderr.write(`telegram-delegate channel: ${msg}\n`)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export function createRouterClient(opts: {
  url: string
  token: string
  sessionId: string
  fetch?: typeof fetch
  /** Reconnect backoff, for tests. Defaults 1000 / 30000. */
  minDelayMs?: number
  maxDelayMs?: number
}): RouterClient {
  const doFetch = opts.fetch ?? fetch
  const base = `${opts.url.replace(/\/+$/, '')}/sessions/${encodeURIComponent(opts.sessionId)}`
  const auth = { authorization: `Bearer ${opts.token}` }
  const minDelay = opts.minDelayMs ?? 1000
  const maxDelay = opts.maxDelayMs ?? 30_000

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await doFetch(`${base}/${path}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      json = {}
    }
    if (!res.ok) {
      const err = (json as { error?: string }).error
      throw new Error(err ? `${err} (HTTP ${res.status})` : `router answered HTTP ${res.status}`)
    }
    return json as T
  }

  async function events(onEvent: (e: SessionEvent) => void, signal: AbortSignal): Promise<void> {
    let delay = minDelay
    while (!signal.aborted) {
      try {
        const res = await doFetch(`${base}/events`, { headers: { ...auth, accept: 'text/event-stream' }, signal })
        if (!res.ok || !res.body) {
          await res.body?.cancel().catch(() => {})
          if (res.status !== 404) log(`events HTTP ${res.status}`)
        } else {
          delay = minDelay
          await readStream(res.body, onEvent)
          if (!signal.aborted) log('events stream ended, reconnecting')
        }
      } catch (e) {
        if (signal.aborted) break
        log(`events: ${e instanceof Error ? e.message : e}`)
      }
      if (signal.aborted) break
      await sleep(delay, signal)
      delay = Math.min(delay * 2, maxDelay)
    }
  }

  return {
    events,
    reply: async a => (await post<{ message_ids: string[] }>('reply', a)).message_ids,
    edit: async a => { await post('edit', a) },
    permission: async r => { await post('permission', r) },
  }
}

async function readStream(body: ReadableStream<Uint8Array>, onEvent: (e: SessionEvent) => void): Promise<void> {
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n')
      if (!data) continue
      try {
        onEvent(JSON.parse(data) as SessionEvent)
      } catch (e) {
        log(`bad event: ${e}`)
      }
    }
  }
}
