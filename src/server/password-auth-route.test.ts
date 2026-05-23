import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Route as PasswordAuthRoute } from '../routes/api/auth/password'
import { getSessionTokenFromCookie } from './auth-middleware'

const passwordAuthHandlers = PasswordAuthRoute.options.server
  ?.handlers as unknown as {
  POST: (ctx: { request: Request }) => Promise<Response>
}

const tempDirs: string[] = []
const originalAuthDbPath = process.env.HERMES_AUTH_DB_PATH
const originalNodeEnv = process.env.NODE_ENV
const originalPasswordJc = process.env.PASSWORD_JC

afterEach(() => {
  vi.restoreAllMocks()
  if (originalAuthDbPath === undefined) {
    delete process.env.HERMES_AUTH_DB_PATH
  } else {
    process.env.HERMES_AUTH_DB_PATH = originalAuthDbPath
  }

  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV
  } else {
    process.env.NODE_ENV = originalNodeEnv
  }

  if (originalPasswordJc === undefined) {
    delete process.env.PASSWORD_JC
  } else {
    process.env.PASSWORD_JC = originalPasswordJc
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function setupTempDbPath() {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hermes-password-route-'),
  )
  tempDirs.push(tempDir)
  const dbPath = path.join(tempDir, 'auth.sqlite')
  process.env.HERMES_AUTH_DB_PATH = dbPath
  return dbPath
}

function passwordRequest(password: string) {
  return new Request('http://localhost/api/auth/password', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.10',
    },
    body: JSON.stringify({ username: 'jc', password }),
  })
}

describe('password auth route local sessions', () => {
  it('creates a local sqlite session without calling Hermes Gateway', async () => {
    const dbPath = setupTempDbPath()
    process.env.NODE_ENV = 'production'
    process.env.PASSWORD_JC = 'secret-abc'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await passwordAuthHandlers.POST({
      request: passwordRequest('secret-abc'),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()

    const setCookie = response.headers.get('set-cookie')
    expect(setCookie).toContain('hermes-auth=')
    const token = getSessionTokenFromCookie(setCookie)
    expect(token).toBeTruthy()

    const db = new DatabaseSync(dbPath)
    const session = db
      .prepare('SELECT token, user_id FROM sessions WHERE token = ?')
      .get(token) as { token: string; user_id: string } | undefined
    expect(session).toEqual({ token, user_id: 'pwd:jc' })
  })

  it('keeps wrong password failures at 401 and does not create a session', async () => {
    const dbPath = setupTempDbPath()
    process.env.NODE_ENV = 'production'
    process.env.PASSWORD_JC = 'secret-abc'

    const response = await passwordAuthHandlers.POST({
      request: passwordRequest('wrong-password'),
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('set-cookie')).toBeNull()

    const db = new DatabaseSync(dbPath)
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
      )
      .get()
    if (!table) return

    const count = db
      .prepare('SELECT COUNT(*) AS count FROM sessions')
      .get() as {
      count: number
    }
    expect(count.count).toBe(0)
  })
})
