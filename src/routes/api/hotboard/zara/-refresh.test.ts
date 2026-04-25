import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionStore, storeSessionToken } from '../../../../server/auth-middleware'

const mockState = vi.hoisted(() => ({
  scrapeZaraYoutubeLibrary: vi.fn(),
  upsertItems: vi.fn(),
}))

vi.mock('../../../../server/hotboard-zara-scraper', () => ({
  scrapeZaraYoutubeLibrary: mockState.scrapeZaraYoutubeLibrary,
}))

vi.mock('../../../../server/hotboard-zara-store', async () => {
  const actual = await vi.importActual<typeof import('../../../../server/hotboard-zara-store')>(
    '../../../../server/hotboard-zara-store',
  )

  return {
    ...actual,
    createZaraStore: vi.fn(() => ({
      upsertItems: mockState.upsertItems,
    })),
  }
})

import { handleHotboardZaraRefreshPost } from './refresh'

const tempDirs: string[] = []
const originalAuthDbPath = process.env.HERMES_AUTH_DB_PATH

afterEach(() => {
  mockState.scrapeZaraYoutubeLibrary.mockReset()
  mockState.upsertItems.mockReset()

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `hotboard-zara-refresh-${suffix}-`))
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

  return { token }
}

function makeRequest(token: string | null) {
  const headers = new Headers({
    'content-type': 'application/json',
    'x-forwarded-for': '127.0.0.1',
  })

  if (token) {
    headers.set('cookie', `hermes-auth=${token}`)
  }

  return new Request('http://localhost/api/hotboard/zara/refresh', {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  })
}

describe('hotboard zara refresh route', () => {
  it('allows owner to refresh the zara library and returns store counts', async () => {
    const { token } = setupTempAuth('owner', 'success')
    mockState.scrapeZaraYoutubeLibrary.mockResolvedValue([
      {
        videoId: '7xTGNNLPyMI',
        url: 'https://www.youtube.com/watch?v=7xTGNNLPyMI',
        title: 'Deep Dive into LLMs like ChatGPT',
        tags: ['Fundamentals'],
      },
    ])
    mockState.upsertItems.mockReturnValue({ added: 1, updated: 0, total: 1 })

    const response = await handleHotboardZaraRefreshPost(makeRequest(token))
    expect(response.status).toBe(200)
    expect(mockState.scrapeZaraYoutubeLibrary).toHaveBeenCalledTimes(1)
    expect(mockState.upsertItems).toHaveBeenCalledWith([
      {
        videoId: '7xTGNNLPyMI',
        url: 'https://www.youtube.com/watch?v=7xTGNNLPyMI',
        title: 'Deep Dive into LLMs like ChatGPT',
        tags: ['Fundamentals'],
      },
    ])

    const payload = (await response.json()) as {
      ok: boolean
      added: number
      updated: number
      total: number
    }

    expect(payload).toEqual({
      ok: true,
      added: 1,
      updated: 0,
      total: 1,
    })
  })

  it('returns an ok empty payload when the scraper detects no items', async () => {
    const { token } = setupTempAuth('owner', 'empty')
    mockState.scrapeZaraYoutubeLibrary.mockResolvedValue([])
    mockState.upsertItems.mockReturnValue({ added: 0, updated: 0, total: 0 })

    const response = await handleHotboardZaraRefreshPost(makeRequest(token))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toEqual({
      ok: true,
      added: 0,
      updated: 0,
      total: 0,
      items: [],
      message: 'no items detected',
    })
  })

  it('rejects unauthenticated and non-owner refresh requests', async () => {
    const unauthorized = await handleHotboardZaraRefreshPost(makeRequest(null))
    expect(unauthorized.status).toBe(401)

    const { token } = setupTempAuth('member', 'forbidden')
    const forbidden = await handleHotboardZaraRefreshPost(makeRequest(token))
    expect(forbidden.status).toBe(403)
  })

  it('returns 429 after 3 refreshes in one hour for the same user', async () => {
    const { token } = setupTempAuth('owner', 'rate-limit')
    mockState.scrapeZaraYoutubeLibrary.mockResolvedValue([])
    mockState.upsertItems.mockReturnValue({ added: 0, updated: 0, total: 0 })

    let lastResponse: Response | null = null
    for (let index = 0; index < 4; index += 1) {
      lastResponse = await handleHotboardZaraRefreshPost(makeRequest(token))
    }

    expect(lastResponse?.status).toBe(429)
  })
})
