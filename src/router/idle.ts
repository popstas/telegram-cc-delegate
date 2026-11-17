import type { RouteStore } from '../routes.ts'
import { A } from '../texts.ts'
import type { Outbound } from './types.ts'

/** Reminds the admin once about every active route silent for idleHours. Returns how many were reported. */
export async function checkIdle(store: RouteStore, out: Outbound, now: number, idleHours: number): Promise<number> {
  let n = 0
  for (const r of store.idleCandidates(now, idleHours * 3600_000)) {
    await out.notifyAdmin(A.idle(r, idleHours))
    store.markIdleNotified(r.sessionId, now)
    n++
  }
  return n
}
