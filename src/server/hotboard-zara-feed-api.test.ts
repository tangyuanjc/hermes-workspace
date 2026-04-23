import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSessionStore, storeSessionToken } from './auth-middleware'
import { createZaraStore } from './hotboard-zara-store'
import { handleHotboardZaraFeedGet } from '../routes/api/hotboard/zara/feed'

const tempDirs: string[] = []
const originalAuthDbPath = process.env.HERMES_AUTH_DB_PATH
const originalZaraDbPath = process.env.HERMES_HOTBOARD_ZARA_DB_PATH

afterEach(() => {
  if (originalAuthDbPath === undefined) {
    delete process.env.HERMES_AUTH_DB_PATH
  } else {
    process.env.HERMES_AUTH_DB_PATH = originalAuthDbPath
  }

  if (originalZaraDbPath === undefined) {
    delete process.env.HERMES_HOTBOARD_ZARA_DB_PATH
  } else {
    process.env.HERMES_HOTBOARD_ZARA_DB_PATH = originalZaraDbPath
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

function setupTempStores() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotboard-zara-feed-'))
  tempDirs.push(tempDir)
  process.env.HERMES_AUTH_DB_PATH = path.join(tempDir, 'auth.sqlite')
  process.env.HERMES_HOTBOARD_ZARA_DB_PATH = path.join(tempDir, 'zara.sqlite')

  const authStore = createSessionStore()
  authStore.upsertUser({
    feishuOpenId: 'ou_feed_owner',
    feishuUnionId: 'union-feed-owner',
    displayName: 'JC',
    role: 'owner',
  })
  storeSessionToken('session-feed-owner', {
    userId: 'ou_feed_owner',
    ttlSeconds: 7 * 24 * 60 * 60,
  })

  const store = createZaraStore()
  store.upsertItems([
    {
      videoId: '7xTGNNLPyMI',
      url: 'https://www.youtube.com/watch?v=7xTGNNLPyMI',
      title: 'Deep Dive into LLMs like ChatGPT',
      channel: 'Andrej Karpathy',
      tags: ['Fundamentals'],
      description: 'The best introduction into LLMs on the Internet',
    },
    {
      videoId: 'ysPbXH0LpIE',
      url: 'https://youtu.be/ysPbXH0LpIE',
      title: 'Prompting 101 | Code w/ Claude',
      channel: 'Anthropic',
      tags: ['Prompting', 'Practical tutorial'],
      description: 'Hands-on guidance on prompting from the Anthropic team',
    },
  ])
}

function makeRequest(limit = '50', withAuth = true) {
  const headers = new Headers({
    'x-forwarded-for': '127.0.0.1',
  })

  if (withAuth) {
    headers.set('cookie', 'hermes-auth=session-feed-owner')
  }

  return new Request(`http://localhost/api/hotboard/zara/feed?limit=${limit}`, {
    headers,
  })
}

describe('hotboard zara feed api handler', () => {
  it('returns recent zara youtube items for authenticated users', async () => {
    setupTempStores()

    const response = await handleHotboardZaraFeedGet(makeRequest('1'))
    expect(response.status).toBe(200)

    const payload = (await response.json()) as {
      last_refreshed_at: string | null
      items: Array<{ videoId: string; title: string }>
    }

    expect(payload.items).toHaveLength(1)
    expect(payload.items[0]).toMatchObject({
      videoId: 'ysPbXH0LpIE',
      title: 'Prompting 101 | Code w/ Claude',
    })
    expect(payload.last_refreshed_at).toBeTypeOf('string')
  })

  it('rejects unauthenticated requests', async () => {
    setupTempStores()

    const response = await handleHotboardZaraFeedGet(makeRequest('50', false))
    expect(response.status).toBe(401)
  })

  it('rejects invalid limit query', async () => {
    setupTempStores()

    const response = await handleHotboardZaraFeedGet(makeRequest('0'))
    expect(response.status).toBe(400)
  })
})
