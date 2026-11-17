import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkIdle } from '../src/router/idle.ts'
import type { Outbound } from '../src/router/types.ts'
import { RouteStore } from '../src/routes.ts'

const H = 3600_000

describe('idle', () => {
  it('notifies once per idle route', async () => {
    const store = new RouteStore(join(mkdtempSync(join(tmpdir(), 'td-idle-')), 'routes.json'))
    const now = 100 * H
    const mk = (id: string, status: 'pending' | 'active' | 'closed', user: string) => {
      store.upsert({ sessionId: id, sessionName: `task-${id}`, headId: 'h', tgUsername: user }, now - 30 * H)
      store.setStatus(id, status)
      store.touch(id, now - 25 * H)
    }
    mk('a', 'active', 'alexiapost')
    mk('p', 'pending', 'pend')
    mk('c', 'closed', 'closed')
    const sent: string[] = []
    const out = { notifyAdmin: async (t: string) => { sent.push(t) } } as unknown as Outbound
    expect(await checkIdle(store, out, now, 24)).toBe(1)
    expect(sent).toEqual(['telegram-delegate: гость @alexiapost молчит 24 ч, сессия task-a открыта.'])
    expect(sent[0]).toContain('молчит 24 ч')
    expect(await checkIdle(store, out, now + H, 24)).toBe(0)
    expect(sent).toHaveLength(1)
  })
})
