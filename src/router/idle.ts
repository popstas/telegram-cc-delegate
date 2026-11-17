import type { RouteStore } from '../routes.ts'
import { errInfo, log } from '../log.ts'
import { TEXTS, type Texts } from '../texts.ts'
import type { Outbound } from './types.ts'

/** Reminds the admin once about every active route silent for idleHours. Returns how many were reported. */
export async function checkIdle(store: RouteStore, out: Outbound, now: number, idleHours: number, texts: Texts = TEXTS.en): Promise<number> {
  let n = 0
  for (const r of store.idleCandidates(now, idleHours * 3600_000)) {
    try {
      await out.notifyAdmin(texts.admin.idle(r, idleHours))
    } catch (e) {
      log(`admin idle ${r.sessionId} failed ${errInfo(e)}`)
      continue
    }
    log(`admin idle ${r.sessionId} ok`)
    store.markIdleNotified(r.sessionId, now)
    n++
  }
  return n
}
