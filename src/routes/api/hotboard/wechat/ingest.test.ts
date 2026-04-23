import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionStore, storeSessionToken } from '../../../../server/auth-middleware'

const mockState = vi.hoisted(() => {
  class MockWechatFetchError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'WechatFetchError'
    }
  }

  class MockWechatFetchTimeoutError extends MockWechatFetchError {
    constructor(message: string) {
      super(message)
      this.name = 'WechatFetchTimeoutError'
    }
  }

  return {
    ingestWechatUrl: vi.fn(),
    WechatFetchError: MockWechatFetchError,
    WechatFetchTimeoutError: MockWechatFetchTimeoutError,
  }
})

vi.mock('../../../../server/hotboard-wechat-ingest', () => ({
  ingestWechatUrl: mockState.ingestWechatUrl,
  WechatFetchError: mockState.WechatFetchError,
  WechatFetchTimeoutError: mockState.WechatFetchTimeoutError,
}))

import { handleHotboardWechatIngestPost } from './ingest'

const tempDirs: string[] = []
const originalAuthDbPath = process.env.HERMES_AUTH_DB_PATH

afterEach(() => {
  mockState.ingestWechatUrl.mockReset()

  if (originalAuthDbPath === undefined) {
    delete process.env.HERMES_AUTH_DB_PATH
  } else {
    process.env.HERMES_AUTH_DB_PATH = originalAuthDbPath
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

function setupTempAuth(role: 'owner' | 'member', suffix: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `hotboard-wechat-route-${suffix}-`))
  tempDirs.push(tempDir)
  process.env.HERMES_AUTH_DB_PATH = path.join(tempDir, 'auth.sqlite')

  const openId = role === 'owner' ? `ou_owner_${suffix}` : `ou_member_${suffix}`
  const token = `session-${role}-${suffix}`

  const store = createSessionStore()
  store.upsertUser({
    feishuOpenId: openId,
    feishuUnionId: `union-${suffix}`,
    displayName: role === 'owner' ? 'JC' : 'Member',
    role,
  })
  storeSessionToken(token, {
    userId: openId,
    ttlSeconds: 7 * 24 * 60 * 60,
  })

  return { token, openId }
}

function makeRequest(token: string | null, url: string) {
  const headers = new Headers({
    'content-type': 'application/json',
  })

  if (token) {
    headers.set('cookie', `hermes-auth=${token}`)
  }

  return new Request('http://localhost/api/hotboard/wechat/ingest', {
    method: 'POST',
    headers,
    body: JSON.stringify({ url }),
  })
}

describe('hotboard wechat ingest route', () => {
  it('allows owner to ingest a wechat url and returns the public article fields only', async () => {
    const { token, openId } = setupTempAuth('owner', 'success')
    mockState.ingestWechatUrl.mockResolvedValue({
      id: 'wechat-1',
      url: 'https://mp.weixin.qq.com/s/example-article',
      title: '测试文章',
      author: '机器之心',
      publish_time: '2026-04-23T15:56:00.000Z',
      size_bytes: 2048,
      markdown_path: '/tmp/article.md',
      excerpt: '前 280 字摘要',
      fetched_at: '2026-04-24T01:00:00.000Z',
      fetched_by_user_id: openId,
    })

    const response = await handleHotboardWechatIngestPost(
      makeRequest(token, 'https://mp.weixin.qq.com/s/example-article'),
    )

    expect(response.status).toBe(200)
    expect(mockState.ingestWechatUrl).toHaveBeenCalledWith(
      'https://mp.weixin.qq.com/s/example-article',
      openId,
    )

    const payload = (await response.json()) as {
      ok: boolean
      article: Record<string, unknown>
    }

    expect(payload.ok).toBe(true)
    expect(payload.article).toEqual({
      id: 'wechat-1',
      url: 'https://mp.weixin.qq.com/s/example-article',
      title: '测试文章',
      author: '机器之心',
      publish_time: '2026-04-23T15:56:00.000Z',
      excerpt: '前 280 字摘要',
    })
  })

  it('rejects invalid wechat article urls with 400', async () => {
    const { token } = setupTempAuth('owner', 'bad-url')

    const response = await handleHotboardWechatIngestPost(
      makeRequest(token, 'https://example.com/not-wechat'),
    )

    expect(response.status).toBe(400)
    expect(mockState.ingestWechatUrl).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated and non-owner sessions', async () => {
    const unauthorized = await handleHotboardWechatIngestPost(
      makeRequest(null, 'https://mp.weixin.qq.com/s/example-article'),
    )
    expect(unauthorized.status).toBe(401)

    const { token } = setupTempAuth('member', 'forbidden')
    const forbidden = await handleHotboardWechatIngestPost(
      makeRequest(token, 'https://mp.weixin.qq.com/s/example-article'),
    )
    expect(forbidden.status).toBe(403)
    expect(mockState.ingestWechatUrl).not.toHaveBeenCalled()
  })

  it('returns 429 after 30 requests in the same minute for one owner', async () => {
    const { token } = setupTempAuth('owner', 'rate-limit')
    mockState.ingestWechatUrl.mockResolvedValue({
      id: 'wechat-rate',
      url: 'https://mp.weixin.qq.com/s/example-rate',
      title: 'rate',
      author: null,
      publish_time: null,
      size_bytes: null,
      markdown_path: '/tmp/rate.md',
      excerpt: 'rate',
      fetched_at: '2026-04-24T01:00:00.000Z',
      fetched_by_user_id: 'owner',
    })

    let lastResponse: Response | null = null
    for (let index = 0; index < 31; index += 1) {
      lastResponse = await handleHotboardWechatIngestPost(
        makeRequest(token, `https://mp.weixin.qq.com/s/example-rate-${index}`),
      )
    }

    expect(lastResponse?.status).toBe(429)
  })

  it('maps fetch timeout to 504 and fetch failure to 502', async () => {
    const { token } = setupTempAuth('owner', 'errors')

    mockState.ingestWechatUrl.mockRejectedValueOnce(
      new mockState.WechatFetchTimeoutError('timed out'),
    )
    const timeoutResponse = await handleHotboardWechatIngestPost(
      makeRequest(token, 'https://mp.weixin.qq.com/s/example-timeout'),
    )
    expect(timeoutResponse.status).toBe(504)

    mockState.ingestWechatUrl.mockRejectedValueOnce(
      new mockState.WechatFetchError('opencli failed'),
    )
    const errorResponse = await handleHotboardWechatIngestPost(
      makeRequest(token, 'https://mp.weixin.qq.com/s/example-error'),
    )
    expect(errorResponse.status).toBe(502)
  })
})
