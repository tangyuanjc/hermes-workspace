import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionCookie, createSessionStore, generateSessionToken } from './auth-middleware'
import { createWechatStore } from './hotboard-wechat-store'
import { createZaraStore } from './hotboard-zara-store'
import { handlePublicDailyGet, handlePublicDailiesGet, handlePublicItemsGet } from './hotboard-public-api'

let tempDir = ''

function makeRequest(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', `127.0.0.${Math.floor(Math.random() * 200) + 1}`)
  return new Request(url, { ...init, headers })
}

function writeXSignalPayload() {
  const payload = {
    generated_at: '2026-05-10T08:00:00.000Z',
    counts: {
      bookmarks: { total: 1, by_user: { jc: 1 } },
      likes: { total: 0, by_user: {} },
      following: { total: 1, by_user: { jc: 1 } },
      for_you: { total: 0, by_user: {} },
    },
    ok: true,
    errors: {},
    bookmarks: [
      {
        id: 'tweet-model',
        author: 'openai',
        name: 'OpenAI',
        text: 'GPT model release with new agent workflow',
        likes: 12,
        retweets: 3,
        replies: 1,
        views: 1000,
        created_at: 'Sun May 10 02:00:00 +0000 2026',
        url: 'https://x.com/openai/status/tweet-model',
        source_user: 'jc',
      },
    ],
    likes: [],
    following: [
      {
        id: 'tweet-old',
        author: 'builder',
        name: 'Builder',
        text: 'Older AI workflow item',
        likes: 5,
        retweets: 1,
        replies: 0,
        views: 100,
        created_at: 'Sat May 09 02:00:00 +0000 2026',
        url: 'https://x.com/builder/status/tweet-old',
        source_user: 'jc',
      },
    ],
    for_you: [],
  }
  fs.writeFileSync(process.env.HOTBOARD_X_SIGNAL_PATH as string, JSON.stringify(payload), 'utf8')
}

function seedStores() {
  const wechatStore = createWechatStore()
  wechatStore.upsertArticle({
    id: 'wechat-1',
    url: 'https://mp.weixin.qq.com/s/article-1',
    title: 'AI 工具日报',
    author: 'AI 公众号',
    publish_time: '2026-05-10T06:00:00.000Z',
    size_bytes: 1200,
    markdown_path: path.join(tempDir, 'article.md'),
    excerpt: '今日 AI 工具和自动化观察。',
    fetched_at: '2026-05-10T06:05:00.000Z',
    fetched_by_user_id: 'jc',
  })

  const zaraStore = createZaraStore()
  zaraStore.upsertItems([
    {
      videoId: 'zara-1',
      url: 'https://www.youtube.com/watch?v=zara-1',
      title: 'AI video workflow',
      channel: 'Zara Zhang',
      tags: ['video', 'AI'],
      description: 'Video generation workflow case.',
      thumbnailUrl: 'https://i.ytimg.com/vi/zara-1/hqdefault.jpg',
      firstSeenAt: '2026-05-10T04:00:00.000Z',
      lastRefreshedAt: '2026-05-10T04:30:00.000Z',
    },
  ])
}

function makeSession(role: 'owner' | 'member') {
  const store = createSessionStore()
  const user = store.upsertUser({ email: `${role}@tangyuanjc.com`, displayName: role, role })
  const token = generateSessionToken()
  store.storeSessionToken(token, { userId: user.id })
  return createSessionCookie(token)
}

function makeAuthedRequest(url: string, role: 'owner' | 'member' = 'member', init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('cookie', makeSession(role))
  return makeRequest(url, { ...init, headers })
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotboard-public-api-'))
  process.env.HOTBOARD_X_SIGNAL_PATH = path.join(tempDir, 'x_signal_sync_latest.json')
  process.env.HOTBOARD_FEED_LASTGOOD_PATH = path.join(tempDir, 'lastgood.json')
  process.env.HERMES_HOTBOARD_WECHAT_DB_PATH = path.join(tempDir, 'wechat.sqlite')
  process.env.HERMES_HOTBOARD_ZARA_DB_PATH = path.join(tempDir, 'zara.sqlite')
  process.env.HERMES_AUTH_DB_PATH = path.join(tempDir, 'auth.sqlite')
  writeXSignalPayload()
  seedStores()
})

afterEach(() => {
  delete process.env.HOTBOARD_X_SIGNAL_PATH
  delete process.env.HOTBOARD_FEED_LASTGOOD_PATH
  delete process.env.HERMES_HOTBOARD_WECHAT_DB_PATH
  delete process.env.HERMES_HOTBOARD_ZARA_DB_PATH
  delete process.env.HERMES_AUTH_DB_PATH
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('hotboard public API', () => {
  it('requires a valid session before returning items', async () => {
    const response = await handlePublicItemsGet(makeRequest('http://localhost/api/aihot/items?date=2026-05-10&limit=50'))
    expect(response.status).toBe(401)
  })

  it('returns public items for an authenticated member without source ids', async () => {
    const response = await handlePublicItemsGet(makeAuthedRequest('http://localhost/api/aihot/items?date=2026-05-10&limit=50'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { date: string; count: number; view: string; items: Array<Record<string, unknown>> }

    expect(body.date).toBe('2026-05-10')
    expect(body.view).toBe('member')
    expect(body.count).toBe(3)
    expect(body.items[0]).toEqual({
      id: expect.stringMatching(/^pub_/),
      title: expect.any(String),
      source: expect.any(String),
      source_tier: 'T2',
      signal_score: expect.any(Number),
      url: expect.any(String),
      timestamp: expect.any(String),
      summary: expect.any(String),
    })
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([
      'id',
      'signal_score',
      'source',
      'source_tier',
      'summary',
      'timestamp',
      'title',
      'url',
    ])
    expect(body.items.some((item) => item.source === 'x-bookmarks')).toBe(false)
    expect(body.items.some((item) => item.source === 'wechat')).toBe(false)
    expect(body.items.some((item) => item.source === 'zara-youtube')).toBe(false)
  })

  it('marks authenticated responses as private and non-cacheable by shared caches', async () => {
    const response = await handlePublicItemsGet(makeAuthedRequest('http://localhost/api/aihot/items?date=2026-05-10'))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })

  it('switches source from member source_name to owner source_id when authenticated as owner', async () => {
    const response = await handlePublicItemsGet(makeAuthedRequest('http://localhost/api/aihot/items?date=2026-05-10', 'owner'))
    const body = (await response.json()) as { view: string; items: Array<{ source: string }> }

    expect(body.view).toBe('owner')
    expect(body.items.map((item) => item.source)).toContain('x-bookmarks')
    expect(body.items.map((item) => item.source)).toContain('wechat')
    expect(body.items.map((item) => item.source)).toContain('zara-youtube')
  })

  it('groups a daily brief into five sections', async () => {
    const response = await handlePublicDailyGet(makeAuthedRequest('http://localhost/api/aihot/daily?date=2026-05-10'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { sections: Array<{ key: string; count: number; items: unknown[] }> }

    expect(body.sections.map((section) => section.key)).toEqual(['models', 'agents', 'tools', 'multimodal', 'industry'])
    expect(body.sections.reduce((sum, section) => sum + section.count, 0)).toBe(3)
  })

  it('returns a seven day dailies list', async () => {
    const response = await handlePublicDailiesGet(makeAuthedRequest('http://localhost/api/aihot/dailies'))
    const body = (await response.json()) as { dailies: Array<{ date: string; count: number }> }

    expect(body.dailies).toHaveLength(7)
    expect(body.dailies[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(body.dailies.some((entry) => entry.date === '2026-05-10' && entry.count === 3)).toBe(true)
  })

  it('does not use user agent as an access-control boundary', async () => {
    const response = await handlePublicItemsGet(makeAuthedRequest('http://localhost/api/aihot/items?date=2026-05-10', 'member', {
      headers: { 'user-agent': 'curl/8.7.1' },
    }))

    expect(response.status).toBe(200)
  })

  it('rate limits public requests at 600 rpm plus burst with 503', async () => {
    const ip = '203.0.113.147'
    let response = new Response(null)
    const cookie = makeSession('member')
    for (let index = 0; index < 641; index += 1) {
      response = await handlePublicItemsGet(makeRequest('http://localhost/api/aihot/items?date=2026-05-10', {
        headers: { cookie, 'x-forwarded-for': ip },
      }))
    }

    expect(response.status).toBe(503)
  })

  it('sets CORS only for tangyuanjc internal domains', async () => {
    const internal = await handlePublicItemsGet(makeAuthedRequest('http://localhost/api/aihot/items?date=2026-05-10', 'member', {
      headers: { origin: 'https://paopao.tangyuanjc.com' },
    }))
    expect(internal.headers.get('access-control-allow-origin')).toBe('https://paopao.tangyuanjc.com')

    const external = await handlePublicItemsGet(makeAuthedRequest('http://localhost/api/aihot/items?date=2026-05-10', 'member', {
      headers: { origin: 'https://example.com' },
    }))
    expect(external.headers.get('access-control-allow-origin')).toBeNull()
  })
})
