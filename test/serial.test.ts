import { describe, expect, it } from 'vitest'
import { createSerial } from '../src/router/serial.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('serial', () => {
  it('keeps order per key and does not block other keys', async () => {
    const run = createSerial()
    const log: string[] = []
    const a1 = run('a', async () => { await sleep(60); log.push('a1') })
    const a2 = run('a', async () => { log.push('a2') })
    const b1 = run('b', async () => { log.push('b1') })
    await b1
    expect(log).toEqual(['b1'])
    await Promise.all([a1, a2])
    expect(log).toEqual(['b1', 'a1', 'a2'])
  })

  it('a failing task does not stop the next one', async () => {
    const errors: unknown[] = []
    const run = createSerial(e => errors.push(e))
    const log: string[] = []
    await Promise.all([run('a', async () => { throw new Error('boom') }), run('a', async () => { log.push('next') })])
    expect(log).toEqual(['next'])
    expect(errors).toHaveLength(1)
  })
})
