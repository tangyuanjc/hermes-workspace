import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionCookie,
  createSessionStore,
  storeSessionToken,
} from './auth-middleware'

const gatewayMock = vi.hoisted(() => ({
  ensureGatewayProbed: vi.fn(),
  getCapabilities: vi.fn(() => ({
    health: false,
    chatCompletions: false,
    models: false,
    streaming: false,
    sessions: false,
    enhancedChat: false,
    skills: false,
    memory: true,
    config: false,
    jobs: false,
    dashboard: { available: false, url: 'http://127.0.0.1:9119' },
    probed: false,
  })),
}))

vi.mock('./gateway-capabilities', () => ({
  ensureGatewayProbed: gatewayMock.ensureGatewayProbed,
  getCapabilities: gatewayMock.getCapabilities,
}))

import { Route as AuthCheckRoute } from '../routes/api/auth-check'

const authCheckHandlers = AuthCheckRoute.options.server
  ?.handlers as unknown as {
  GET: (ctx: { request: Request }) => Promise<Response>
}

const tempDirs: string[] = []
const originalAuthDbPath = process.env.HERMES_AUTH_DB_PATH
const originalPasswordJc = process.env.PASSWORD_JC
const originalEmailDisabled = process.env.HERMES_EMAIL_AUTH_DISABLED
const originalHermesPassword = process.env.HERMES_PASSWORD
const originalFeishuAppId = process.env.FEISHU_APP_ID
const originalFeishuAppSecret = process.env.FEISHU_APP_SECRET

afterEach(() => {
  gatewayMock.ensureGatewayProbed.mockReset()
  gatewayMock.getCapabilities.mockClear()

  if (originalAuthDbPath === undefined) {
    delete process.env.HERMES_AUTH_DB_PATH
  } else {
    process.env.HERMES_AUTH_DB_PATH = originalAuthDbPath
  }
  if (originalPasswordJc === undefined) {
    delete process.env.PASSWORD_JC
  } else {
    process.env.PASSWORD_JC = originalPasswordJc
  }
  if (originalEmailDisabled === undefined) {
    delete process.env.HERMES_EMAIL_AUTH_DISABLED
  } else {
    process.env.HERMES_EMAIL_AUTH_DISABLED = originalEmailDisabled
  }
  if (originalHermesPassword === undefined) {
    delete process.env.HERMES_PASSWORD
  } else {
    process.env.HERMES_PASSWORD = originalHermesPassword
  }
  if (originalFeishuAppId === undefined) {
    delete process.env.FEISHU_APP_ID
  } else {
    process.env.FEISHU_APP_ID = originalFeishuAppId
  }
  if (originalFeishuAppSecret === undefined) {
    delete process.env.FEISHU_APP_SECRET
  } else {
    process.env.FEISHU_APP_SECRET = originalFeishuAppSecret
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function setupTempAuth() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-auth-check-'))
  tempDirs.push(tempDir)
  process.env.HERMES_AUTH_DB_PATH = path.join(tempDir, 'auth.sqlite')
  process.env.PASSWORD_JC = 'secret-abc'
  process.env.HERMES_EMAIL_AUTH_DISABLED = '1'
  delete process.env.HERMES_PASSWORD
  delete process.env.FEISHU_APP_ID
  delete process.env.FEISHU_APP_SECRET

  const store = createSessionStore()
  store.upsertUser({
    feishuOpenId: 'pwd:jc',
    displayName: 'JC',
    role: 'owner',
  })
  storeSessionToken('local-token', {
    userId: 'pwd:jc',
    ttlSeconds: 7 * 24 * 60 * 60,
  })
  return createSessionCookie('local-token')
}

describe('auth-check without Hermes Gateway', () => {
  it('returns from local sqlite without awaiting a stuck gateway probe', async () => {
    const cookie = setupTempAuth()
    gatewayMock.ensureGatewayProbed.mockReturnValue(new Promise(() => {}))

    const result = await Promise.race([
      authCheckHandlers.GET({
        request: new Request('http://localhost/api/auth-check', {
          headers: { cookie },
        }),
      }),
      new Promise<'timed-out'>((resolve) =>
        setTimeout(() => resolve('timed-out'), 25),
      ),
    ])

    expect(result).not.toBe('timed-out')
    const response = result as Response
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      authenticated: boolean
      authRequired: boolean
      authMode: string
      hermesGatewayReachable: boolean
      user: { id: string; role: string } | null
    }
    expect(body).toMatchObject({
      authenticated: true,
      authRequired: true,
      authMode: 'password',
      hermesGatewayReachable: false,
      user: { id: 'pwd:jc', role: 'owner' },
    })
  })

  it('treats PASSWORD_* config as password auth even without HERMES_PASSWORD', async () => {
    setupTempAuth()

    const response = await authCheckHandlers.GET({
      request: new Request('http://localhost/api/auth-check'),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      authenticated: boolean
      authRequired: boolean
      authMode: string
    }
    expect(body).toMatchObject({
      authenticated: false,
      authRequired: true,
      authMode: 'password',
    })
  })
})
