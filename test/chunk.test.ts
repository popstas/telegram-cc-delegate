import { describe, expect, it } from 'vitest'
import { chunk } from '../src/router/chunk.ts'

describe('chunk', () => {
  it('short text one chunk', () => {
    expect(chunk('hello')).toEqual(['hello'])
  })

  it('splits at newline before limit', () => {
    expect(chunk('a'.repeat(10) + '\n' + 'b'.repeat(10), 15)).toEqual(['a'.repeat(10), 'b'.repeat(10)])
  })

  it('hard split without newline', () => {
    expect(chunk('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
  })

  it('every chunk <= 4096', () => {
    let text = ''
    let i = 0
    while (text.length < 10000) text += `*bold_${i}* [link](x) _it_ ${i++}` + (i % 7 === 0 ? '\n' : ' ')
    const parts = chunk(text)
    expect(parts.length).toBeGreaterThan(2)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096)
    expect(parts.join('').replace(/\n/g, '').length).toBe(text.replace(/\n/g, '').length)
  })
})
