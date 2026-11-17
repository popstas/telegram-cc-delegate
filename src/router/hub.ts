import type { ServerResponse } from 'node:http'
import type { SessionEvent } from './types.ts'

const PING_MS = 25_000
const MAX_QUEUE = 200

/** One SSE subscription per session. A new subscription replaces the old one. */
export class Hub {
  private subs = new Map<string, { res: ServerResponse; ping: NodeJS.Timeout }>()
  private detachCbs: Array<(sessionId: string) => void> = []
  /** Events for an active session whose subscriber is reconnecting (router restart, grace window). */
  private queues = new Map<string, SessionEvent[]>()

  attach(sessionId: string, res: ServerResponse): void {
    const prev = this.subs.get(sessionId)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    for (const ev of this.queues.get(sessionId) ?? []) res.write(`data: ${JSON.stringify(ev)}\n\n`)
    this.queues.delete(sessionId)
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)
    ping.unref()
    this.subs.set(sessionId, { res, ping })
    res.on('close', () => {
      clearInterval(ping)
      if (this.subs.get(sessionId)?.res !== res) return
      this.subs.delete(sessionId)
      for (const cb of this.detachCbs) cb(sessionId)
    })
    if (prev) prev.res.end()
  }

  send(sessionId: string, ev: SessionEvent): boolean {
    const sub = this.subs.get(sessionId)
    if (!sub || sub.res.writableEnded || sub.res.destroyed) return false
    sub.res.write(`data: ${JSON.stringify(ev)}\n\n`)
    return true
  }

  /** Keeps the event until the session subscribes again. */
  enqueue(sessionId: string, ev: SessionEvent): void {
    const q = this.queues.get(sessionId) ?? []
    q.push(ev)
    if (q.length > MAX_QUEUE) q.shift()
    this.queues.set(sessionId, q)
  }

  /** Drops queued events; returns how many were dropped. */
  dropQueue(sessionId: string): number {
    const n = this.queues.get(sessionId)?.length ?? 0
    this.queues.delete(sessionId)
    return n
  }

  connected(sessionId: string): boolean {
    return this.subs.has(sessionId)
  }

  onDetach(cb: (sessionId: string) => void): void {
    this.detachCbs.push(cb)
  }

  closeAll(): void {
    for (const { res, ping } of this.subs.values()) {
      clearInterval(ping)
      res.end()
    }
    this.subs.clear()
  }
}
