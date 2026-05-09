import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionStore, storeSessionToken } from '../../../server/auth-middleware'

const mockState = vi.hoisted(() => ({
  listSourceHealth: vi.fn(),
  retryRedSources: vi.fn(),
  retrySource: vi.fn(),
}))

vi.mock('../../../server/source-registry', () => ({
  listSourceHealth: mockState.listSourceHealth,
  retryRedSources: mockState.retryRedSources,
  retrySource: mockState.retrySource,
}))

import { handleSourcesHealthGet } from './health'
import { handleSourcesHealthRetryPost } from './health/retry'

const tempDirs: string[] = []
const originalAuthDbPath = process.env.HERMES_AUTH_DB_PATH

afterEach(() => {
  mockState.listSourceHealth.mockReset()
  mockState.retryRedSources.mockReset()
  mockState.retrySource.mockReset()

  if (originalAuthDbPath === undefined) {
    delete process.env.HERMES_AUTH_DB_PATH
  } else {
    process.env.HERMES_AUTH_DB_PATH = originalAuthDbPath
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function setupTempAuth(role: 'owner' | 'member', suffix: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `sources-health-${suffix}-`))
  tempDirs.push(tempDir)
  process.env.HERMES_AUTH_DB_PATH = path.join(tempDir, 'auth.sqlite')

  const openId = `ou_${role}_${suffix}`
  const token = `session-${role}-${suffix}`
  const store = createSessionStore()
  store.upsertUser({
    feishuOpenId: openId,
    feishuUnionId: `union-${suffix}`,
    displayName: role === 'owner' ? 'JC' : '泡泡',
    role,
  })
  storeSessionToken(token, { userId: openId, ttlSeconds: 7 * 24 * 60 * 60 })
  return { token }
}

function makeRequest(token: string | null, url = 'http://localhost/api/sources/health', init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set('x-forwarded-for', '127.0.0.1')
  if (token) headers.set('cookie', `hermes-auth=${token}`)
  return new Request(url, { ...init, headers })
}

function detailedHealth() {
  return [{
    id: 'x-signal',
    displayName: 'X bookmarks',
    kind: 'launchd' as const,
    trigger: 'launchd ai.hermes.x-signal-sync 6h',
    last_success_at: '2026-05-06T10:00:00.000Z',
    last_failure_at: '2026-05-06T11:00:00.000Z',
    last_failure_reason: '/Users/tangyuanjc/.hermes/tmp/x_signal_sync_latest.json parse stack',
    count: 0,
    status: 'red' as const,
  }]
}

describe('sources health api permissions', () => {
  it('returns only safe source summaries for member GET without retry side effects', async () => {
    const { token } = setupTempAuth('member', 'safe-get')
    mockState.listSourceHealth.mockResolvedValue(detailedHealth())
    mockState.retryRedSources.mockResolvedValue({ sources: detailedHealth(), retries: [] })

    const response = await handleSourcesHealthGet(makeRequest(token))
    const payload = await response.json() as { sources: Array<Record<string, unknown>> }

    expect(response.status).toBe(200)
    expect(payload.sources).toEqual([{ source_name: 'X bookmarks', status_chip: 'red' }])
    expect(Object.keys(payload.sources[0] ?? {}).sort()).toEqual(['source_name', 'status_chip'])
    expect(JSON.stringify(payload)).not.toContain('x-signal')
    expect(JSON.stringify(payload)).not.toContain('launchd')
    expect(JSON.stringify(payload)).not.toContain('/Users/tangyuanjc')
    expect(mockState.retryRedSources).not.toHaveBeenCalled()
  })

  it('forbids member retry POST before touching source triggers', async () => {
    const { token } = setupTempAuth('member', 'retry-forbidden')
    const response = await handleSourcesHealthRetryPost(makeRequest(
      token,
      'http://localhost/api/sources/health/retry',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source_id: 'x-signal' }),
      },
    ))

    expect(response.status).toBe(403)
    expect(mockState.retrySource).not.toHaveBeenCalled()
  })
})
