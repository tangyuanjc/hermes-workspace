import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionCookie, createSessionStore, generateSessionToken } from './auth-middleware'
import { handleImgProxyGet } from './img-proxy-api'

let tempDir = ''

function encodeUrl(url: string) {
  return Buffer.from(url, 'utf8').toString('base64')
}

function makeRequest(url: string) {
  return new Request(`http://localhost/api/img-proxy?u=${encodeURIComponent(encodeUrl(url))}`)
}

function makeSession() {
  const store = createSessionStore()
  const user = store.upsertUser({ email: 'member@tangyuanjc.com', displayName: 'member', role: 'member' })
  const token = generateSessionToken()
  store.storeSessionToken(token, { userId: user.id })
  return createSessionCookie(token)
}

function makeAuthedRequest(url: string) {
  return new Request(`http://localhost/api/img-proxy?u=${encodeURIComponent(encodeUrl(url))}`, {
    headers: { cookie: makeSession() },
  })
}

const resolvePublicHost = async () => ['203.0.113.10']

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-proxy-api-'))
  process.env.HERMES_AUTH_DB_PATH = path.join(tempDir, 'auth.sqlite')
})

afterEach(() => {
  delete process.env.HERMES_AUTH_DB_PATH
  fs.rmSync(tempDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('img proxy API', () => {
  it('requires a valid session before proxying images', async () => {
    const response = await handleImgProxyGet(makeRequest('https://pbs.twimg.com/media/a.png'), {
      cacheDir: tempDir,
      resolveHost: resolvePublicHost,
    })

    expect(response.status).toBe(401)
  })

  it('rejects non-https URLs for SSRF protection', async () => {
    const response = await handleImgProxyGet(makeAuthedRequest('http://internal-service/image.png'), { cacheDir: tempDir })
    expect(response.status).toBe(403)
  })

  it('rejects hosts outside the image allowlist', async () => {
    const fetchImpl = vi.fn()
    const response = await handleImgProxyGet(makeAuthedRequest('https://internal-service.tangyuanjc.com/image.png'), {
      fetchImpl,
      cacheDir: tempDir,
    })

    expect(response.status).toBe(403)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects allowlisted hosts when DNS resolves to private addresses', async () => {
    const fetchImpl = vi.fn()
    const response = await handleImgProxyGet(makeAuthedRequest('https://pbs.twimg.com/media/a.png'), {
      fetchImpl,
      cacheDir: tempDir,
      resolveHost: async () => ['169.254.169.254'],
    })

    expect(response.status).toBe(403)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects allowlisted hosts when DNS resolves to IPv6 ULA addresses', async () => {
    const fetchImpl = vi.fn()
    const response = await handleImgProxyGet(makeAuthedRequest('https://pbs.twimg.com/media/a.png'), {
      fetchImpl,
      cacheDir: tempDir,
      resolveHost: async () => ['fc00::1'],
    })

    expect(response.status).toBe(403)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('manually validates redirects and rejects http downgrade targets', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://internal-service/image.png' },
    }))
    const response = await handleImgProxyGet(makeAuthedRequest('https://pbs.twimg.com/media/a.png'), {
      fetchImpl,
      cacheDir: tempDir,
      resolveHost: resolvePublicHost,
    })

    expect(response.status).toBe(403)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' })
  })

  it('rejects non-image content types', async () => {
    const fetchImpl = vi.fn(async () => new Response('hello', { headers: { 'content-type': 'text/html' } }))
    const response = await handleImgProxyGet(makeAuthedRequest('https://pbs.twimg.com/page'), {
      fetchImpl,
      cacheDir: tempDir,
      resolveHost: resolvePublicHost,
    })

    expect(response.status).toBe(403)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects images larger than 5MB by content length', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1]), {
      headers: {
        'content-type': 'image/png',
        'content-length': String(5 * 1024 * 1024 + 1),
      },
    }))
    const response = await handleImgProxyGet(makeAuthedRequest('https://pbs.twimg.com/huge.png'), {
      fetchImpl,
      cacheDir: tempDir,
      resolveHost: resolvePublicHost,
    })

    expect(response.status).toBe(413)
  })

  it('caches valid images on disk for subsequent requests', async () => {
    const body = new Uint8Array([137, 80, 78, 71])
    const fetchImpl = vi.fn(async () => new Response(body, { headers: { 'content-type': 'image/png' } }))
    const request = makeAuthedRequest('https://pbs.twimg.com/avatar.png')

    const first = await handleImgProxyGet(request, {
      fetchImpl,
      cacheDir: tempDir,
      now: () => new Date('2026-05-10T00:00:00.000Z'),
      resolveHost: resolvePublicHost,
    })
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/png')
    expect(first.headers.get('x-img-proxy-cache')).toBe('MISS')

    const second = await handleImgProxyGet(request, {
      fetchImpl,
      cacheDir: tempDir,
      now: () => new Date('2026-05-11T00:00:00.000Z'),
      resolveHost: resolvePublicHost,
    })
    expect(second.status).toBe(200)
    expect(second.headers.get('x-img-proxy-cache')).toBe('HIT')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
