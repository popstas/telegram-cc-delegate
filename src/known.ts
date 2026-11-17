import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { log } from './log.ts'
import { normUsername, type Route } from './routes.ts'

/** A person who wrote to the bot: the bot can write to them first. No message content here. */
export interface KnownPerson {
  id: string
  username?: string
  lastSeenAt: number
}

/** username <-> numeric id of everyone who wrote to the bot in private (known.json next to routes.json). */
export class KnownStore {
  private readonly file: string
  private byId = new Map<string, KnownPerson>()

  constructor(file: string) {
    this.file = file
    if (!existsSync(file)) return
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { people?: KnownPerson[] }
      for (const p of data.people ?? []) if (p?.id) this.byId.set(String(p.id), { ...p, id: String(p.id) })
    } catch (e) {
      // A broken file must not stop the router: the memory refills from incoming messages.
      log(`known.json unreadable, starting empty: ${e instanceof Error ? e.message : e}`)
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ people: [...this.byId.values()] }, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (e) {
      log(`known.json write failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  private put(id: string, username: string | undefined, at: number): boolean {
    const prev = this.byId.get(id)
    if (prev && prev.lastSeenAt > at) return false
    // One owner per username: a renamed or reassigned username drops the stale pair.
    if (username) {
      for (const p of this.byId.values()) if (p.id !== id && p.username === username) delete p.username
    }
    const next: KnownPerson = { id, lastSeenAt: at }
    const u = username ?? prev?.username
    if (u) next.username = u
    this.byId.set(id, next)
    return true
  }

  /** Every private message from a person (also when the bot answered "no session"). */
  see(from: { id: string; username?: string }, now: number): void {
    // A message without @username means the person has none now: forget the old one.
    const u = normUsername(from.username)
    const prev = this.byId.get(from.id)
    if (prev && !u) delete prev.username
    if (this.put(from.id, u, now)) this.save()
  }

  /** On start: routes that know both username and id. Newer entries are kept. */
  seed(routes: Route[]): number {
    let n = 0
    for (const r of routes) {
      const u = normUsername(r.tgUsername)
      if (!u || !r.tgUserId) continue
      const at = r.lastMessageAt ?? r.createdAt
      const prev = this.byId.get(r.tgUserId)
      if (prev && prev.lastSeenAt >= at) continue
      // An older route must not take a username that someone else has used since.
      const owner = [...this.byId.values()].find(p => p.username === u && p.id !== r.tgUserId)
      if (owner && owner.lastSeenAt >= at) continue
      if (this.put(r.tgUserId, u, at)) n++
    }
    if (n) this.save()
    return n
  }

  idByUsername(username: string | undefined): string | undefined {
    const u = normUsername(username)
    if (!u) return undefined
    for (const p of this.byId.values()) if (p.username === u) return p.id
    return undefined
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  list(): KnownPerson[] {
    return [...this.byId.values()]
  }
}
