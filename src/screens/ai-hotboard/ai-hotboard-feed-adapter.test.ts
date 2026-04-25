import { describe, expect, it } from 'vitest'
import { mapFeedEventToMockEvent, toSupportedHotboardSource } from './ai-hotboard-feed-adapter'

describe('ai hotboard feed adapter', () => {
  it('maps x feed payload into mock-event compatible shape', () => {
    const mapped = mapFeedEventToMockEvent(
      {
        event_id: 'tweet-123',
        source: 'x-bookmarks',
        source_line: '@builder · Builder Name',
        source_user: 'builder',
        title: 'A feed title',
        summary: 'A feed summary',
        signal_score: 88,
        likes: 11,
        created_at: 'Wed Apr 16 12:00:00 +0000 2026',
      },
      'fallback-id',
      'x-bookmarks',
    )

    expect(mapped.id).toBe('tweet-123')
    expect(mapped.source_channel).toBe('x-bookmarks')
    expect(mapped.signal_score).toBe(88)
    expect(mapped.engagement.likes).toBe(11)
    expect(mapped.created_at).toContain('2026')
    expect(mapped.source_user).toBe('builder')
  })

  it('does not expose an empty x source user pill value', () => {
    const mapped = mapFeedEventToMockEvent(
      {
        event_id: 'tweet-456',
        source: 'x-likes',
        source_line: '@builder · Builder Name',
        source_user: '   ',
      },
      'fallback-id',
      'x-likes',
    )

    expect(mapped.source_user).toBe('')
  })

  it('normalizes unsupported route source to all', () => {
    expect(toSupportedHotboardSource('x-bookmarks')).toBe('x-bookmarks')
    expect(toSupportedHotboardSource('x-for_you')).toBe('x-for_you')
    expect(toSupportedHotboardSource('wechat')).toBe('wechat')
    expect(toSupportedHotboardSource('bad-source')).toBe('all')
  })
})
