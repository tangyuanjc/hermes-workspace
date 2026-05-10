import { describe, expect, it } from 'vitest'
import { dateInShanghai } from './shanghai-date'

describe('dateInShanghai', () => {
  it('buckets Shanghai early-morning timestamps into the Shanghai calendar date', () => {
    expect(dateInShanghai('2026-05-09T19:00:00.000Z')).toBe('2026-05-10')
  })
})
