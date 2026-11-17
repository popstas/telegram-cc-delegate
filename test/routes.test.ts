import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RouteStore, guestLabel } from '../src/routes.ts'

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'td-routes-')), 'routes.json')
}

const base = { sessionName: 'guest-task', headId: 'head-1' }

describe('RouteStore', () => {
  it('upsert creates pending route', () => {
    const file = tmpFile()
    const store = new RouteStore(file)
    const { route, moved } = store.upsert({ ...base, sessionId: 's1', tgUsername: 'alexiapost' }, 1000)
    expect(route.status).toBe('pending')
    expect(route.createdAt).toBe(1000)
    expect(moved).toBeUndefined()
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    expect(JSON.stringify(disk)).toContain('"s1"')
  })

  it('upsert same sessionId updates fields without move', () => {
    const store = new RouteStore(tmpFile())
    store.upsert({ ...base, sessionId: 's1', tgUsername: 'alexiapost' }, 1000)
    store.setStatus('s1', 'active')
    const { route, moved } = store.upsert({ ...base, sessionId: 's1', sessionName: 'renamed', tgUsername: 'alexiapost' }, 2000)
    expect(moved).toBeUndefined()
    expect(route.sessionName).toBe('renamed')
    expect(route.status).toBe('active')
    expect(route.createdAt).toBe(1000)
  })

  it('upsert moves active route of same user', () => {
    const store = new RouteStore(tmpFile())
    store.upsert({ ...base, sessionId: 'A', tgUsername: 'alexiapost' }, 1000)
    store.setStatus('A', 'active')
    const { route, moved } = store.upsert({ ...base, sessionId: 'B', tgUsername: '@AlexiaPost' }, 2000)
    expect(moved?.sessionId).toBe('A')
    expect(store.get('A')?.status).toBe('closed')
    expect(route.sessionId).toBe('B')
    expect(route.status).toBe('pending')
  })

  it('matchSender pins id', () => {
    const store = new RouteStore(tmpFile())
    store.upsert({ ...base, sessionId: 's1', tgUsername: 'alexiapost' }, 1000)
    const r = store.matchSender({ id: '42', username: 'alexiapost' })
    expect(r?.sessionId).toBe('s1')
    expect(store.get('s1')?.tgUserId).toBe('42')
    expect(store.matchSender({ id: '42', username: 'renamed' })?.sessionId).toBe('s1')
    expect(store.matchSender({ id: '43', username: 'alexiapost' })).toBeUndefined()
  })

  it('matchSender: newer username route wins over older pinned id route', () => {
    const store = new RouteStore(tmpFile())
    const moves: Array<[string, string]> = []
    store.onMoved((from, to) => moves.push([from.sessionId, to.sessionId]))
    store.upsert({ ...base, sessionId: 'A', tgUserId: '42' }, 1000)
    store.setStatus('A', 'active')
    store.upsert({ ...base, sessionId: 'B', tgUsername: '@alexiapost' }, 2000)
    expect(store.get('A')?.status).toBe('active')
    expect(store.matchSender({ id: '42', username: 'AlexiaPost' })?.sessionId).toBe('B')
    expect(store.get('A')?.status).toBe('closed')
    expect(store.get('B')?.tgUserId).toBe('42')
    expect(moves).toEqual([['A', 'B']])
    expect(store.matchSender({ id: '42', username: 'alexiapost' })?.sessionId).toBe('B')
    expect(moves).toHaveLength(1)
  })

  it('matchSender: renamed guest delegated under the new username', () => {
    const store = new RouteStore(tmpFile())
    const moves: Array<[string, string]> = []
    store.onMoved((from, to) => moves.push([from.sessionId, to.sessionId]))
    store.upsert({ ...base, sessionId: 'A', tgUsername: 'old' }, 1000)
    store.setStatus('A', 'active')
    store.matchSender({ id: '42', username: 'old' })
    store.upsert({ ...base, sessionId: 'B', tgUsername: 'new' }, 2000)
    expect(store.matchSender({ id: '42', username: 'new' })?.sessionId).toBe('B')
    expect(store.get('A')?.status).toBe('closed')
    expect(moves).toEqual([['A', 'B']])
  })

  it('matchSender: older unpinned username route loses to newer id route', () => {
    const store = new RouteStore(tmpFile())
    const moves: Array<[string, string]> = []
    store.onMoved((from, to) => moves.push([from.sessionId, to.sessionId]))
    store.upsert({ ...base, sessionId: 'A', tgUsername: 'alexiapost' }, 1000)
    store.upsert({ ...base, sessionId: 'B', tgUserId: '42' }, 2000)
    expect(store.matchSender({ id: '42', username: 'alexiapost' })?.sessionId).toBe('B')
    expect(store.get('A')?.status).toBe('closed')
    expect(moves).toEqual([['A', 'B']])
  })

  it('matchSender ignores closed routes', () => {
    const store = new RouteStore(tmpFile())
    store.upsert({ ...base, sessionId: 's1', tgUserId: '42' }, 1000)
    store.setStatus('s1', 'closed')
    expect(store.matchSender({ id: '42' })).toBeUndefined()
  })

  it('store survives reload', () => {
    const file = tmpFile()
    const store = new RouteStore(file)
    store.upsert({ ...base, sessionId: 's1', tgUsername: 'alexiapost' }, 1000)
    store.setStatus('s1', 'active')
    const again = new RouteStore(file)
    expect(again.list()).toHaveLength(1)
    expect(again.get('s1')?.status).toBe('active')
  })

  it('idleCandidates', () => {
    const store = new RouteStore(tmpFile())
    const hour = 3600_000
    store.upsert({ ...base, sessionId: 's1', tgUserId: '42' }, 0)
    store.setStatus('s1', 'active')
    store.touch('s1', 1 * hour)
    store.upsert({ ...base, sessionId: 's2', tgUserId: '43' }, 0)
    store.setStatus('s2', 'active')
    store.touch('s2', 20 * hour)
    const now = 26 * hour
    expect(store.idleCandidates(now, 24 * hour).map(r => r.sessionId)).toEqual(['s1'])
    store.markIdleNotified('s1', now)
    expect(store.idleCandidates(now, 24 * hour)).toEqual([])
  })

  it('guestLabel prefers username', () => {
    const store = new RouteStore(tmpFile())
    const a = store.upsert({ ...base, sessionId: 's1', tgUsername: 'alexiapost', tgUserId: '42' }, 0).route
    const b = store.upsert({ ...base, sessionId: 's2', tgUserId: '43' }, 0).route
    expect(guestLabel(a)).toBe('@alexiapost')
    expect(guestLabel(b)).toBe('43')
  })
})
