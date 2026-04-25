import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSessionStore, storeSessionToken } from '../../server/auth-middleware'
import { handleWhoamiGet } from './whoami'

const tempDirs: string[] = []
const originalAuthDbPath = process.env.HERMES_AUTH_DB_PATH

afterEach(() => {
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `whoami-route-${suffix}-`))
  tempDirs.push(tempDir)
  process.env.HERMES_AUTH_DB_PATH = path.join(tempDir, 'auth.sqlite')

  const openId = role === 'owner' ? `ou_owner_${suffix}` : `ou_member_${suffix}`
  const token = `session-${role}-${suffix}`

  const store = createSessionStore()
  store.upsertUser({
    feishuOpenId: openId,
    feishuUnionId: `union-${suffix}`,
    displayName: role === 'owner' ? 'JC' : '泡泡',
    role,
  })
  storeSessionToken(token, {
    userId: openId,
    ttlSeconds: 7 * 24 * 60 * 60,
  })

  return { token, openId }
}

function makeRequest(token: string | null) {
  const headers = new Headers()
  if (token) {
    headers.set('cookie', `hermes-auth=${token}`)
  }
  return new Request('http://localhost/api/whoami', { headers })
}

describe('whoami route', () => {
  it('returns session metadata for any logged-in user', async () => {
    const { token, openId } = setupTempAuth('member', 'success')

    const response = handleWhoamiGet(makeRequest(token))

    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload).toEqual({
      user_id: openId,
      role: 'member',
      displayName: '泡泡',
      session_created_at: expect.any(String),
      session_expires_at: expect.any(String),
    })
  })

  it('rejects requests without a valid session', async () => {
    const response = handleWhoamiGet(makeRequest(null))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'unauthorized' })
  })
})
