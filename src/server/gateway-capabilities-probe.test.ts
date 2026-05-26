import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalHermesApiUrl = process.env.HERMES_API_URL
const originalHermesDashboardUrl = process.env.HERMES_DASHBOARD_URL

beforeEach(() => {
  vi.resetModules()
  process.env.HERMES_API_URL = 'http://gateway.test'
  process.env.HERMES_DASHBOARD_URL = 'http://dashboard.test'
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalHermesApiUrl === undefined) {
    delete process.env.HERMES_API_URL
  } else {
    process.env.HERMES_API_URL = originalHermesApiUrl
  }
  if (originalHermesDashboardUrl === undefined) {
    delete process.env.HERMES_DASHBOARD_URL
  } else {
    process.env.HERMES_DASHBOARD_URL = originalHermesDashboardUrl
  }
})

function mockGatewayStatus(status: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url =
        input instanceof Request ? input.url : input instanceof URL ? input.href : input
      if (url === 'http://dashboard.test/api/status') {
        return Response.json(status >= 200 && status < 300 ? { version: 'test' } : {}, {
          status,
        })
      }
      if (url === 'http://dashboard.test/') {
        return new Response(
          'window.__HERMES_SESSION_TOKEN__ = "test-token"',
          { status: 200 },
        )
      }
      return new Response('{}', { status })
    }),
  )
}

async function probeWithStatus(status: number) {
  mockGatewayStatus(status)
  const { probeGateway } = await import('./gateway-capabilities')
  return probeGateway({ force: true })
}

describe('gateway capability probes', () => {
  it('marks HTTP 500 probe responses unavailable', async () => {
    const capabilities = await probeWithStatus(500)

    expect(capabilities.health).toBe(false)
    expect(capabilities.chatCompletions).toBe(false)
    expect(capabilities.models).toBe(false)
    expect(capabilities.sessions).toBe(false)
    expect(capabilities.skills).toBe(false)
    expect(capabilities.config).toBe(false)
    expect(capabilities.jobs).toBe(false)
  })

  it('marks HTTP 404 probe responses unavailable', async () => {
    const capabilities = await probeWithStatus(404)

    expect(capabilities.health).toBe(false)
    expect(capabilities.models).toBe(false)
    expect(capabilities.sessions).toBe(false)
    expect(capabilities.skills).toBe(false)
    expect(capabilities.config).toBe(false)
    expect(capabilities.jobs).toBe(false)
  })

  it('marks HTTP 2xx probe responses available', async () => {
    const capabilities = await probeWithStatus(200)

    expect(capabilities.health).toBe(true)
    expect(capabilities.models).toBe(true)
    expect(capabilities.sessions).toBe(true)
    expect(capabilities.skills).toBe(true)
    expect(capabilities.config).toBe(true)
    expect(capabilities.jobs).toBe(true)
  })
})
