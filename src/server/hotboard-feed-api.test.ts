import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSessionStore, storeSessionToken } from './auth-middleware'
import { handleHotboardFeedGet, lowFollowerFilter } from './hotboard-feed-api'

const tempDirs: string[] = []
const originalXFeedPath = process.env.HOTBOARD_X_SIGNAL_PATH
const originalLastGoodPath = process.env.HOTBOARD_FEED_LASTGOOD_PATH
const originalAuthDbPath = process.env.HERMES_AUTH_DB_PATH
const originalMockFallback = process.env.HOTBOARD_ENABLE_MOCK_FEED_FALLBACK
const originalFeedFreshnessHours = process.env.HOTBOARD_FEED_FRESHNESS_HOURS

afterEach(() => {
  if (originalXFeedPath === undefined) {
    delete process.env.HOTBOARD_X_SIGNAL_PATH
  } else {
    process.env.HOTBOARD_X_SIGNAL_PATH = originalXFeedPath
  }

  if (originalLastGoodPath === undefined) {
    delete process.env.HOTBOARD_FEED_LASTGOOD_PATH
  } else {
    process.env.HOTBOARD_FEED_LASTGOOD_PATH = originalLastGoodPath
  }

  if (originalAuthDbPath === undefined) {
    delete process.env.HERMES_AUTH_DB_PATH
  } else {
    process.env.HERMES_AUTH_DB_PATH = originalAuthDbPath
  }

  if (originalMockFallback === undefined) {
    delete process.env.HOTBOARD_ENABLE_MOCK_FEED_FALLBACK
  } else {
    process.env.HOTBOARD_ENABLE_MOCK_FEED_FALLBACK = originalMockFallback
  }

  if (originalFeedFreshnessHours === undefined) {
    delete process.env.HOTBOARD_FEED_FRESHNESS_HOURS
  } else {
    process.env.HOTBOARD_FEED_FRESHNESS_HOURS = originalFeedFreshnessHours
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

function setupTempAuth() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotboard-feed-api-'))
  tempDirs.push(tempDir)
  process.env.HERMES_AUTH_DB_PATH = path.join(tempDir, 'auth.sqlite')

  const store = createSessionStore()
  store.upsertUser({
    feishuOpenId: 'ou_40ece573ca861adce640dc9ea5054460',
    feishuUnionId: 'on_owner',
    displayName: 'JC',
    role: 'owner',
  })

  storeSessionToken('session-jc', {
    userId: 'ou_40ece573ca861adce640dc9ea5054460',
    ttlSeconds: 7 * 24 * 60 * 60,
  })

  process.env.HOTBOARD_FEED_LASTGOOD_PATH = path.join(tempDir, 'hotboard-feed-lastgood.json')

  return tempDir
}

function withValidFeedDefaults(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const record = payload as Record<string, unknown>
  const countFor = (key: string) => {
    const value = record[key]
    const total = Array.isArray(value) ? value.length : 0
    return { total, by_user: { self: total } }
  }
  return {
    generated_at: '2026-05-06T10:00:00.000Z',
    counts: {
      bookmarks: countFor('bookmarks'),
      likes: countFor('likes'),
      following: countFor('following'),
      for_you: countFor('for_you'),
    },
    ...record,
  }
}

function xSignalCounts(overrides: Partial<Record<'bookmarks' | 'likes' | 'following' | 'for_you', number>> = {}) {
  const build = (total: number) => ({ total, by_user: { self: total } })
  return {
    bookmarks: build(overrides.bookmarks ?? 0),
    likes: build(overrides.likes ?? 0),
    following: build(overrides.following ?? 0),
    for_you: build(overrides.for_you ?? 0),
  }
}

function createTempFeedFile(payload: unknown, options: { withDefaults?: boolean } = {}) {
  const tempDir = setupTempAuth()
  const feedPath = path.join(tempDir, 'x_signal_sync_latest.json')
  const nextPayload = options.withDefaults === false ? payload : withValidFeedDefaults(payload)
  fs.writeFileSync(feedPath, JSON.stringify(nextPayload, null, 2), 'utf-8')
  process.env.HOTBOARD_X_SIGNAL_PATH = feedPath
  return feedPath
}

function makeRequest(url: string) {
  return new Request(url, {
    headers: {
      'x-forwarded-for': '127.0.0.1',
      cookie: 'hermes-auth=session-jc',
    },
  })
}

describe('hotboard feed api handlers', () => {
  it('filters low-follower viral X events by proxy engagement heuristic', () => {
    const filtered = lowFollowerFilter([
      {
        event_id: 'viral-high-ratio',
        source: 'x-for_you',
        source_line: '@small · Small Account',
        source_user: 'jc',
        title: 'viral high ratio',
        summary: 'viral high ratio',
        signal_score: 88,
        likes: 10,
        retweets: 46,
        views: 1000,
        replies: 20,
        created_at: 'Wed Apr 16 12:00:00 +0000 2026',
        url: '',
        timestamp_ms: 1000,
      },
      {
        event_id: 'viral-lower-ratio',
        source: 'x-bookmarks',
        source_line: '@small2 · Small Account 2',
        source_user: 'jc',
        title: 'viral lower ratio',
        summary: 'viral lower ratio',
        signal_score: 85,
        likes: 20,
        retweets: 75,
        views: 1000,
        replies: 30,
        created_at: 'Wed Apr 16 11:00:00 +0000 2026',
        url: '',
        timestamp_ms: 900,
      },
      {
        event_id: 'low-volume-noise',
        source: 'x-for_you',
        source_line: '@tiny · Tiny Account',
        source_user: 'jc',
        title: 'low volume noise',
        summary: 'low volume noise',
        signal_score: 88,
        likes: 1,
        retweets: 20,
        views: 100,
        replies: 10,
        created_at: 'Wed Apr 16 12:30:00 +0000 2026',
        url: '',
        timestamp_ms: 1100,
      },
      {
        event_id: 'popular-not-proxy',
        source: 'x-likes',
        source_line: '@big · Big Account',
        source_user: 'jc',
        title: 'popular but like-heavy',
        summary: 'popular but like-heavy',
        signal_score: 90,
        likes: 200,
        retweets: 30,
        views: 1000,
        replies: 10,
        created_at: 'Wed Apr 16 10:00:00 +0000 2026',
        url: '',
        timestamp_ms: 800,
      },
    ])

    expect(filtered.map((event) => event.event_id)).toEqual(['viral-high-ratio', 'viral-lower-ratio'])
    expect(filtered[0]?.title).toBe('viral high ratio')
    expect(filtered[0]?.signal_score).toBe(88)
  })

  it('winsorizes low-follower proxy sorting at the 95th percentile', () => {
    const events = Array.from({ length: 20 }, (_, index) => ({
      event_id: `baseline-${index}`,
      source: 'x-for_you' as const,
      source_line: '@small · Small Account',
      source_user: 'jc',
      title: `baseline ${index}`,
      summary: `baseline ${index}`,
      signal_score: 80,
      likes: 5,
      retweets: 30 + index,
      views: 1000,
      replies: 0,
      created_at: 'Wed Apr 16 12:00:00 +0000 2026',
      url: '',
      timestamp_ms: 1000 - index,
    }))
    const extreme = {
      ...events[0],
      event_id: 'extreme-low-like',
      title: 'extreme low like',
      likes: 1,
      retweets: 1000,
      timestamp_ms: 2000,
    }

    const filtered = lowFollowerFilter([...events, extreme])

    expect(filtered[0]?.event_id).not.toBe('extreme-low-like')
    expect(filtered.map((event) => event.event_id)).toContain('extreme-low-like')
  })

  it('returns low-follower proxy feed from all X sources', async () => {
    createTempFeedFile({
      bookmarks: [
        {
          id: 'bookmark-viral',
          text: 'bookmark viral proxy',
          likes: 10,
          retweets: 46,
          replies: 20,
          views: 100,
          created_at: 'Wed Apr 16 12:00:00 +0000 2026',
        },
      ],
      likes: [
        {
          id: 'like-mainstream',
          text: 'like mainstream',
          likes: 200,
          retweets: 30,
          replies: 10,
          views: 100,
          created_at: 'Wed Apr 16 11:00:00 +0000 2026',
        },
      ],
      following: [],
      for_you: [],
    })

    const response = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=low-follower'))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { source: string; events: Array<{ event_id: string; title: string }> }

    expect(payload.source).toBe('low-follower')
    expect(payload.events.map((event) => event.event_id)).toEqual(['x-bookmarks-self-bookmark-viral'])
    expect(payload.events[0]?.title).toBe('bookmark viral proxy')
  })

  it('returns transformed x feed cards for source=x-bookmarks', async () => {
    createTempFeedFile({
      bookmarks: [
        {
          id: 'tweet-1',
          author: 'builder',
          name: 'Builder Name',
          text: 'A'.repeat(220),
          likes: 7,
          retweets: 2,
          views: 150,
          replies: 0,
          created_at: 'Wed Apr 16 09:35:02 +0000 2026',
          url: 'https://x.com/builder/status/tweet-1',
        },
      ],
      likes: [],
      following: [],
      for_you: [],
    })

    const response = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=x-bookmarks'))
    expect(response.status).toBe(200)

    const payload = (await response.json()) as {
      ok: boolean
      source: string
      count: number
      data_source: string
      fallback: boolean
      events: Array<Record<string, unknown>>
    }

    expect(payload.ok).toBe(true)
    expect(payload.source).toBe('x-bookmarks')
    expect(payload.count).toBe(1)
    expect(payload.data_source).toBe('x_signal_sync_latest.json')
    expect(payload.fallback).toBe(false)
    expect(payload.events[0]?.event_id).toBe('x-bookmarks-self-tweet-1')
    expect(typeof payload.events[0]?.signal_score).toBe('number')
    expect(String(payload.events[0]?.summary).length).toBeLessThanOrEqual(203)
    expect(payload.events[0]?.source_line).toBe('@builder · Builder Name')
  })

  it('does not infer x.com photo permalinks as image urls', async () => {
    createTempFeedFile({
      bookmarks: [
        {
          id: 'tweet-photo-permalink',
          author: 'foo',
          name: 'Foo',
          text: 'Production scraper emits x.com photo permalinks here',
          likes: 7,
          retweets: 2,
          views: 150,
          replies: 0,
          created_at: 'Wed Apr 16 09:35:02 +0000 2026',
          url: 'https://x.com/foo/status/123',
          media: [
            {
              type: 'photo',
              url: 'https://x.com/foo/status/123/photo/1',
            },
          ],
        },
      ],
      likes: [],
      following: [],
      for_you: [],
    })

    const response = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=x-bookmarks'))
    expect(response.status).toBe(200)

    const payload = (await response.json()) as {
      events: Array<{ image_url?: string }>
    }

    expect(payload.events[0]?.image_url).toBeUndefined()
  })

  it('keeps x media CDN URLs as image urls', async () => {
    createTempFeedFile({
      bookmarks: [
        {
          id: 'tweet-cdn-photo',
          author: 'foo',
          name: 'Foo',
          text: 'Real CDN image URL should survive feed mapping',
          likes: 7,
          retweets: 2,
          views: 150,
          replies: 0,
          created_at: 'Wed Apr 16 09:35:02 +0000 2026',
          url: 'https://x.com/foo/status/124',
          media: [
            {
              type: 'photo',
              media_url_https: 'https://pbs.twimg.com/media/abc?format=jpg',
            },
          ],
        },
      ],
      likes: [],
      following: [],
      for_you: [],
    })

    const response = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=x-bookmarks'))
    expect(response.status).toBe(200)

    const payload = (await response.json()) as {
      events: Array<{ image_url?: string }>
    }

    expect(payload.events[0]?.image_url).toBe('https://pbs.twimg.com/media/abc?format=jpg')
  })

  it('returns merged timeline for source=all sorted by created_at desc', async () => {
    createTempFeedFile({
      bookmarks: [
        {
          id: 'bookmark-new',
          author: 'a',
          name: 'A',
          text: 'new bookmark',
          likes: 10,
          retweets: 2,
          views: 100,
          replies: 0,
          created_at: 'Wed Apr 16 12:00:00 +0000 2026',
        },
      ],
      likes: [
        {
          id: 'like-old',
          author: 'b',
          name: 'B',
          text: 'old like',
          likes: 1,
          retweets: 0,
          views: 20,
          replies: 0,
          created_at: 'Wed Apr 16 10:00:00 +0000 2026',
        },
      ],
      following: [
        {
          id: 'follow-mid',
          author: 'c',
          name: 'C',
          text: 'mid follow',
          likes: 3,
          retweets: 1,
          views: 50,
          replies: 0,
          created_at: 'Wed Apr 16 11:00:00 +0000 2026',
        },
      ],
      for_you: [],
    })

    const response = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=all'))
    expect(response.status).toBe(200)

    const payload = (await response.json()) as {
      count: number
      events: Array<{ event_id: string }>
    }

    expect(payload.count).toBe(3)
    expect(payload.events.map((item) => item.event_id)).toEqual([
      'x-bookmarks-self-bookmark-new',
      'x-following-self-follow-mid',
      'x-likes-self-like-old',
    ])
  })

  it('namespaces event_id by source and source_user to prevent vote collisions', async () => {
    createTempFeedFile({
      bookmarks: [
        {
          id: 'tweet-shared',
          source_user: 'jc',
          text: 'shared tweet via bookmark',
          created_at: 'Wed Apr 16 12:00:00 +0000 2026',
        },
      ],
      likes: [
        {
          id: 'tweet-shared',
          source_user: 'jc',
          text: 'shared tweet via like',
          created_at: 'Wed Apr 16 11:00:00 +0000 2026',
        },
      ],
      following: [
        {
          id: 'tweet-shared',
          source_user: 'kol',
          text: 'shared tweet via kol',
          created_at: 'Wed Apr 16 10:00:00 +0000 2026',
        },
      ],
      for_you: [],
    })

    const response = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=all'))
    const payload = (await response.json()) as { events: Array<{ event_id: string }> }

    expect(payload.events.map((item) => item.event_id)).toEqual([
      'x-bookmarks-jc-tweet-shared',
      'x-likes-jc-tweet-shared',
      'x-following-kol-tweet-shared',
    ])
    expect(new Set(payload.events.map((item) => item.event_id)).size).toBe(3)
  })

  it('surfaces producer partial failures in feed meta', async () => {
    createTempFeedFile({
      ok: false,
      errors: {
        'jc:bookmarks': 'rate limited',
      },
      counts: xSignalCounts({ bookmarks: 1 }),
      generated_at: new Date().toISOString(),
      bookmarks: [
        {
          id: 'tweet-1',
          source_user: 'jc',
          text: 'partial payload still has one tweet',
          created_at: 'Wed Apr 16 12:00:00 +0000 2026',
        },
      ],
      likes: [],
      following: [],
      for_you: [],
    })

    const response = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=x-bookmarks'))
    const payload = (await response.json()) as {
      fallback: boolean
      empty_reason?: string
      meta: { stale: boolean; partial_failures: string[] }
      events: Array<{ event_id: string }>
    }

    expect(payload.fallback).toBe(false)
    expect(payload.events).toHaveLength(1)
    expect(payload.empty_reason).toBeUndefined()
    expect(payload.meta).toMatchObject({
      status: 'fresh',
      stale: false,
      partial_failures: ['jc:bookmarks'],
    })
  })

  it('marks all-failed empty x payloads as source_failure instead of no_data', async () => {
    createTempFeedFile({
      ok: false,
      errors: {
        'jc:bookmarks': 'rate limited',
        'jc:likes': 'rate limited',
      },
      counts: xSignalCounts(),
      generated_at: new Date().toISOString(),
      bookmarks: [],
      likes: [],
      following: [],
      for_you: [],
    }, { withDefaults: false })

    const response = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=x-bookmarks'))
    const payload = (await response.json()) as {
      count: number
      empty_reason?: string
      meta: { status?: string; stale: boolean; partial_failures: string[]; source_failure_reason?: string | null }
      events: Array<Record<string, unknown>>
    }

    expect(payload.count).toBe(0)
    expect(payload.events).toEqual([])
    expect(payload.empty_reason).toBe('source_failure')
    expect(payload.meta.status).toBe('stale')
    expect(payload.meta.stale).toBe(true)
    expect(payload.meta.partial_failures).toEqual(['jc:bookmarks', 'jc:likes'])
    expect(payload.meta.source_failure_reason).toBe('jc:bookmarks, jc:likes')
  })

  it('marks x feed meta stale when generated_at is older than 24 hours', async () => {
    createTempFeedFile({
      ok: true,
      errors: {},
      generated_at: '2026-04-20T00:00:00.000Z',
      bookmarks: [
        {
          id: 'tweet-stale',
          text: 'stale tweet',
          created_at: 'Wed Apr 16 12:00:00 +0000 2026',
        },
      ],
      likes: [],
      following: [],
      for_you: [],
    })

    const response = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=x-bookmarks'))
    const payload = (await response.json()) as { meta: { stale: boolean; partial_failures: string[] } }

    expect(payload.meta.stale).toBe(true)
    expect(payload.meta.partial_failures).toEqual([])
  })

  it('marks x feed meta stale using HOTBOARD_FEED_FRESHNESS_HOURS', async () => {
    process.env.HOTBOARD_FEED_FRESHNESS_HOURS = '1'
    createTempFeedFile({
      ok: true,
      errors: {},
      counts: xSignalCounts({ bookmarks: 1 }),
      generated_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      bookmarks: [
        {
          id: 'tweet-stale-env',
          text: 'stale by env threshold',
          created_at: 'Wed Apr 16 12:00:00 +0000 2026',
        },
      ],
      likes: [],
      following: [],
      for_you: [],
    }, { withDefaults: false })

    const response = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=x-bookmarks'))
    const payload = (await response.json()) as { meta: { stale: boolean; freshness_hours?: number } }

    expect(payload.meta.stale).toBe(true)
    expect(payload.meta.freshness_hours).toBe(1)
  })

  it('marks numeric count payloads stale instead of treating them as fresh', async () => {
    createTempFeedFile({
      ok: true,
      errors: {},
      counts: { bookmarks: 1, likes: 0, following: 0 },
      generated_at: new Date().toISOString(),
      bookmarks: [
        {
          id: 'tweet-numeric-counts',
          text: 'schema drift tweet',
          created_at: 'Wed Apr 16 12:00:00 +0000 2026',
        },
      ],
      likes: [],
      following: [],
      for_you: [],
    }, { withDefaults: false })

    const response = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=x-bookmarks'))
    const payload = (await response.json()) as {
      count: number
      empty_reason?: string
      meta: { status?: string; stale: boolean; partial_failures: string[] }
      events: Array<Record<string, unknown>>
    }

    expect(payload.count).toBe(0)
    expect(payload.events).toEqual([])
    expect(payload.empty_reason).toBe('source_failure')
    expect(payload.meta.status).toBe('stale')
    expect(payload.meta.stale).toBe(true)
    expect(payload.meta.partial_failures).toContain('invalid_x_signal_schema')
  })

  it('marks schema-invalid x payload stale instead of treating it as fresh', async () => {
    createTempFeedFile({
      counts: xSignalCounts({ bookmarks: 1 }),
      bookmarks: [
        {
          id: 'tweet-missing-generated-at',
          text: 'schema drift tweet',
          created_at: 'Wed Apr 16 12:00:00 +0000 2026',
        },
      ],
      likes: [],
      following: [],
      for_you: [],
    }, { withDefaults: false })

    const response = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=x-bookmarks'))
    const payload = (await response.json()) as {
      count: number
      empty_reason?: string
      meta: { status?: string; stale: boolean; partial_failures: string[] }
      events: Array<Record<string, unknown>>
    }

    expect(payload.count).toBe(0)
    expect(payload.events).toEqual([])
    expect(payload.empty_reason).toBe('source_failure')
    expect(payload.meta.status).toBe('stale')
    expect(payload.meta.stale).toBe(true)
    expect(payload.meta.partial_failures).toContain('invalid_x_signal_schema')
  })

  it('returns stale last-good events when latest x signal file is missing', async () => {
    const feedPath = createTempFeedFile({
      ok: true,
      errors: {},
      counts: xSignalCounts({ bookmarks: 1 }),
      generated_at: '2026-05-06T10:00:00.000Z',
      bookmarks: [
        {
          id: 'tweet-last-good',
          text: 'last good tweet',
          created_at: 'Wed Apr 16 12:00:00 +0000 2026',
        },
      ],
      likes: [],
      following: [],
      for_you: [],
    })

    const freshResponse = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=x-bookmarks'))
    const freshPayload = (await freshResponse.json()) as { count: number; events: Array<Record<string, unknown>> }
    expect(freshPayload.count).toBe(1)
    expect(freshPayload.events[0]?.event_id).toBe('x-bookmarks-self-tweet-last-good')

    fs.rmSync(feedPath)
    const staleResponse = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=x-bookmarks'))
    const stalePayload = (await staleResponse.json()) as {
      count: number
      empty_reason?: string
      meta: { status?: string; stale: boolean; partial_failures: string[]; last_success_at?: string }
      events: Array<Record<string, unknown>>
    }

    expect(stalePayload.count).toBe(1)
    expect(stalePayload.empty_reason).toBeUndefined()
    expect(stalePayload.meta.status).toBe('stale')
    expect(stalePayload.meta.stale).toBe(true)
    expect(stalePayload.meta.partial_failures).toContain('missing_x_signal_latest')
    expect(stalePayload.meta.last_success_at).toBe('2026-05-06T10:00:00.000Z')
    expect(stalePayload.events[0]?.event_id).toBe('x-bookmarks-self-tweet-last-good')
  })

  it('returns explicit no_data empty reason for valid empty x payloads', async () => {
    createTempFeedFile({
      ok: true,
      errors: {},
      counts: xSignalCounts({ bookmarks: 0 }),
      generated_at: new Date().toISOString(),
      bookmarks: [],
      likes: [],
      following: [],
      for_you: [],
    })

    const response = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=x-bookmarks'))
    const payload = (await response.json()) as {
      count: number
      empty_reason?: string
      meta: { status?: string; stale: boolean; partial_failures: string[] }
      events: Array<Record<string, unknown>>
    }

    expect(payload.count).toBe(0)
    expect(payload.events).toEqual([])
    expect(payload.empty_reason).toBe('no_data')
    expect(payload.meta.status).toBe('fresh')
    expect(payload.meta.stale).toBe(false)
  })

  it('does not fall back to mock data for x-bookmarks when the x signal file is missing', async () => {
    const tempDir = setupTempAuth()
    process.env.HOTBOARD_X_SIGNAL_PATH = path.join(tempDir, 'x_signal_sync_latest.json')

    const response = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=x-bookmarks'))
    expect(response.status).toBe(200)

    const payload = (await response.json()) as {
      ok: boolean
      fallback: boolean
      data_source: string
      meta: { stale: boolean; partial_failures: string[] }
      count: number
      events: Array<Record<string, unknown>>
    }

    expect(payload.ok).toBe(true)
    expect(payload.fallback).toBe(false)
    expect(payload.data_source).toBe('x_signal_sync_latest.json')
    expect(payload.count).toBe(0)
    expect(payload.events).toEqual([])
  })

  it('falls back to mock data when x feed file is missing', async () => {
    setupTempAuth()
    process.env.HOTBOARD_ENABLE_MOCK_FEED_FALLBACK = '1'
    process.env.HOTBOARD_X_SIGNAL_PATH = path.join(os.tmpdir(), 'missing-hotboard-feed.json')
    const response = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=x-following'))
    expect(response.status).toBe(200)

    const payload = (await response.json()) as {
      ok: boolean
      fallback: boolean
      data_source: string
      meta: { stale: boolean; partial_failures: string[] }
      count: number
      events: Array<Record<string, unknown>>
    }

    expect(payload.ok).toBe(true)
    expect(payload.fallback).toBe(true)
    expect(payload.data_source).toBe('ai_hotboard_mock_events.json')
    expect(payload.meta).toEqual({ status: 'fresh', stale: false, partial_failures: [] })
    expect(payload.count).toBeGreaterThan(0)
    expect(payload.events[0]).toHaveProperty('event_id')
    expect(payload.events[0]).toHaveProperty('signal_score')
  })

  it('returns 400 on invalid source query value', async () => {
    setupTempAuth()
    const response = await handleHotboardFeedGet(makeRequest('http://localhost/api/hotboard/feed?source=bad-source'))
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { ok: boolean; error: string }
    expect(payload.ok).toBe(false)
    expect(payload.error).toContain('Invalid source')
  })
})
