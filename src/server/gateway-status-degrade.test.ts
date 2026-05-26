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
  getGatewayMode: vi.fn(() => 'disconnected'),
  getChatMode: vi.fn(() => 'disconnected'),
}))

vi.mock('./gateway-capabilities', () => ({
  HERMES_API: 'http://127.0.0.1:8645',
  HERMES_DASHBOARD_URL: 'http://127.0.0.1:9119',
  ensureGatewayProbed: gatewayMock.ensureGatewayProbed,
  getCapabilities: gatewayMock.getCapabilities,
  getGatewayMode: gatewayMock.getGatewayMode,
  getChatMode: gatewayMock.getChatMode,
}))

import { Route as ConnectionStatusRoute } from '../routes/api/connection-status'
import { Route as GatewayStatusRoute } from '../routes/api/gateway-status'
import { Route as HermesConfigRoute } from '../routes/api/hermes-config'

const connectionStatusHandlers = ConnectionStatusRoute.options.server
  ?.handlers as unknown as {
  GET: (ctx: { request: Request }) => Promise<Response>
}

const gatewayStatusHandlers = GatewayStatusRoute.options.server
  ?.handlers as unknown as {
  GET: (ctx: { request: Request }) => Promise<Response>
}

const hermesConfigHandlers = HermesConfigRoute.options.server
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
  gatewayMock.getGatewayMode.mockClear()
  gatewayMock.getChatMode.mockClear()

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
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hermes-gateway-status-'),
  )
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

function authedRequest(url: string) {
  return new Request(url, {
    headers: {
      cookie: setupTempAuth(),
      'x-forwarded-for': '203.0.113.10',
    },
  })
}

describe('gateway status endpoints without Hermes Gateway', () => {
  it('connection-status degrades instead of throwing when gateway probing fails', async () => {
    gatewayMock.ensureGatewayProbed.mockRejectedValue(new Error('gateway down'))

    const response = await connectionStatusHandlers.GET({
      request: authedRequest('http://localhost/api/connection-status'),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      status: string
      chatReady: boolean
    }
    expect(body).toMatchObject({
      status: 'disconnected',
      disconnected: true,
      gatewayReachable: false,
      chatReady: false,
    })
  })

  it('gateway-status returns disconnected metadata when gateway probing fails', async () => {
    gatewayMock.ensureGatewayProbed.mockRejectedValue(new Error('gateway down'))

    const response = await gatewayStatusHandlers.GET({
      request: authedRequest('http://localhost/api/gateway-status'),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      mode: string
      gateway: { available: boolean }
      dashboard: { available: boolean }
    }
    expect(body).toMatchObject({
      mode: 'disconnected',
      disconnected: true,
      gateway: { available: false },
      dashboard: { available: false },
    })
  })

  it('hermes-config returns config-unavailable metadata when gateway probing fails', async () => {
    gatewayMock.ensureGatewayProbed.mockRejectedValue(new Error('gateway down'))

    const response = await hermesConfigHandlers.GET({
      request: authedRequest('http://localhost/api/hermes-config'),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      code: string
      capability: string
      disconnected: boolean
      gatewayReachable: boolean
      gatewayError: string
      config: Record<string, unknown>
      providers: Array<unknown>
    }
    expect(body).toMatchObject({
      ok: false,
      code: 'capability_unavailable',
      capability: 'config',
      disconnected: true,
      gatewayReachable: false,
      gatewayError: 'gateway down',
      config: {},
      providers: [],
    })
  })
})
