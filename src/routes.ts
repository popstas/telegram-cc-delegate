import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type RouteStatus = 'pending' | 'active' | 'lost' | 'closed'

export interface Route {
  sessionId: string
  sessionName: string
  headId: string
  tgUsername?: string
  tgUserId?: string
  status: RouteStatus
  createdAt: number
  lastMessageAt?: number
  idleNotifiedAt?: number
}

export interface RouteInput {
  sessionId: string
  sessionName: string
  headId: string
  tgUsername?: string
  tgUserId?: string
}

/** "@AlexiaPost" -> "alexiapost" */
export function normUsername(u: string | undefined): string | undefined {
  if (u == null) return undefined
  const s = u.trim().replace(/^@/, '').toLowerCase()
  return s || undefined
}

/** "@username" or numeric id. */
export function guestLabel(r: Route): string {
  return r.tgUsername ? `@${r.tgUsername}` : (r.tgUserId ?? '?')
}

function sameGuest(a: Route, b: { tgUsername?: string; tgUserId?: string }): boolean {
  if (a.tgUserId && b.tgUserId) return a.tgUserId === b.tgUserId
  const ua = normUsername(a.tgUsername)
  const ub = normUsername(b.tgUsername)
  return !!ua && ua === ub
}

export class RouteStore {
  private readonly file: string
  private routes = new Map<string, Route>()

  constructor(file: string) {
    this.file = file
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { routes?: Route[] }
      for (const r of data.routes ?? []) this.routes.set(r.sessionId, r)
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ routes: [...this.routes.values()] }, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  upsert(input: RouteInput, now: number): { route: Route; moved?: Route } {
    const tgUsername = normUsername(input.tgUsername)
    const tgUserId = input.tgUserId?.trim() || undefined
    const existing = this.routes.get(input.sessionId)
    let route: Route
    if (existing) {
      route = { ...existing, sessionName: input.sessionName, headId: input.headId }
      if (tgUsername) route.tgUsername = tgUsername
      if (tgUserId) route.tgUserId = tgUserId
    } else {
      route = { sessionId: input.sessionId, sessionName: input.sessionName, headId: input.headId, status: 'pending', createdAt: now }
      if (tgUsername) route.tgUsername = tgUsername
      if (tgUserId) route.tgUserId = tgUserId
    }
    // One open route per guest: an older open route of the same person is closed.
    let moved: Route | undefined
    for (const other of this.routes.values()) {
      if (other.sessionId === route.sessionId || other.status === 'closed') continue
      if (!sameGuest(other, route)) continue
      other.status = 'closed'
      if (!moved || other.createdAt > moved.createdAt) moved = other
      // Keep the pinned id when the new route only knows the username.
      if (!route.tgUserId && other.tgUserId) route.tgUserId = other.tgUserId
    }
    this.routes.set(route.sessionId, route)
    this.save()
    return moved ? { route, moved: { ...moved } } : { route }
  }

  /** Route for an incoming sender. A username-only route pins the sender's id on first match. */
  matchSender(from: { id: string; username?: string }): Route | undefined {
    const open = [...this.routes.values()].filter(r => r.status !== 'closed').sort((a, b) => b.createdAt - a.createdAt)
    const byId = open.find(r => r.tgUserId === from.id)
    if (byId) return byId
    const u = normUsername(from.username)
    if (!u) return undefined
    const byName = open.find(r => !r.tgUserId && normUsername(r.tgUsername) === u)
    if (!byName) return undefined
    byName.tgUserId = from.id
    this.save()
    return byName
  }

  get(sessionId: string): Route | undefined {
    return this.routes.get(sessionId)
  }

  list(): Route[] {
    return [...this.routes.values()]
  }

  setStatus(sessionId: string, status: RouteStatus): Route | undefined {
    const r = this.routes.get(sessionId)
    if (!r) return undefined
    r.status = status
    this.save()
    return r
  }

  touch(sessionId: string, now: number): void {
    const r = this.routes.get(sessionId)
    if (!r) return
    r.lastMessageAt = now
    delete r.idleNotifiedAt
    this.save()
  }

  /** Active routes silent for idleMs (since last message, or since creation) and not yet reminded. */
  idleCandidates(now: number, idleMs: number): Route[] {
    return this.list().filter(r => r.status === 'active' && r.idleNotifiedAt == null && now - (r.lastMessageAt ?? r.createdAt) >= idleMs)
  }

  markIdleNotified(sessionId: string, now: number): void {
    const r = this.routes.get(sessionId)
    if (!r) return
    r.idleNotifiedAt = now
    this.save()
  }
}
