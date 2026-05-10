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
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'manual' }))
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
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]))
      },
    })
    const upstream = new Response(stream, {
      headers: {
        'content-type': 'image/png',
        'content-length': String(5 * 1024 * 1024 + 1),
      },
    })
    const getReader = vi.spyOn(upstream.body!, 'getReader')
    const fetchImpl = vi.fn(async () => upstream)
    const response = await handleImgProxyGet(makeAuthedRequest('https://pbs.twimg.com/huge.png'), {
      fetchImpl,
      cacheDir: tempDir,
      resolveHost: resolvePublicHost,
    })

    expect(response.status).toBe(413)
    expect(getReader).not.toHaveBeenCalled()
  })

  it('passes through upstream 4xx and maps upstream 5xx to bad gateway', async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = input.toString()
      if (url.includes('missing')) return new Response('not found', { status: 404 })
      return new Response('unavailable', { status: 503 })
    })

    const missing = await handleImgProxyGet(makeAuthedRequest('https://pbs.twimg.com/missing.png'), {
      fetchImpl,
      cacheDir: tempDir,
      resolveHost: resolvePublicHost,
    })
    const unavailable = await handleImgProxyGet(makeAuthedRequest('https://pbs.twimg.com/unavailable.png'), {
      fetchImpl,
      cacheDir: tempDir,
      resolveHost: resolvePublicHost,
    })

    expect(missing.status).toBe(404)
    expect(unavailable.status).toBe(502)
  })

  it('rejects SVG even when it is served as an image', async () => {
    const fetchImpl = vi.fn(async () => new Response('<svg><script>alert(1)</script></svg>', {
      headers: { 'content-type': 'image/svg+xml' },
    }))
    const response = await handleImgProxyGet(makeAuthedRequest('https://pbs.twimg.com/vector.svg'), {
      fetchImpl,
      cacheDir: tempDir,
      resolveHost: resolvePublicHost,
    })

    expect(response.status).toBe(403)
  })

  it('rejects images larger than 5MB while streaming the body', async () => {
    let pulls = 0
    let canceled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(1024 * 1024))
        if (pulls >= 8) controller.close()
      },
      cancel() {
        canceled = true
      },
    })
    const fetchImpl = vi.fn(async () => new Response(stream, { headers: { 'content-type': 'image/png' } }))
    const response = await handleImgProxyGet(makeAuthedRequest('https://pbs.twimg.com/huge-stream.png'), {
      fetchImpl,
      cacheDir: tempDir,
      resolveHost: resolvePublicHost,
    })

    expect(response.status).toBe(413)
    expect(canceled).toBe(true)
    expect(pulls).toBeLessThan(8)
  })

  it('times out and cancels slow streaming image responses', async () => {
    vi.useFakeTimers()
    let canceled = false
    let fetchSignal: AbortSignal | undefined
    let chunks = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        chunks += 1
        controller.enqueue(chunks === 1 ? new Uint8Array([137, 80, 78, 71]) : new Uint8Array([0]))
        if (chunks >= 12) controller.close()
      },
      cancel() {
        canceled = true
      },
    })
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      fetchSignal = init?.signal as AbortSignal | undefined
      return new Response(stream, { headers: { 'content-type': 'image/png' } })
    })

    try {
      const responsePromise = handleImgProxyGet(makeAuthedRequest('https://pbs.twimg.com/slow-stream.png'), {
        fetchImpl,
        cacheDir: tempDir,
        resolveHost: resolvePublicHost,
      })

      await vi.advanceTimersByTimeAsync(12_000)
      const response = await responsePromise

      expect(response.status).toBe(504)
      expect(canceled).toBe(true)
      expect(fetchSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects image responses whose magic bytes do not match allowed bitmap formats', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6]), {
      headers: { 'content-type': 'image/png' },
    }))
    const response = await handleImgProxyGet(makeAuthedRequest('https://pbs.twimg.com/fake.png'), {
      fetchImpl,
      cacheDir: tempDir,
      resolveHost: resolvePublicHost,
    })

    expect(response.status).toBe(403)
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
    expect(first.headers.get('x-content-type-options')).toBe('nosniff')
    expect(first.headers.get('content-disposition')).toBe('inline; filename="avatar.png"')
    expect(first.headers.get('x-img-proxy-cache')).toBe('MISS')
    expect(first.headers.get('cache-control')).toContain('private')
    expect(first.headers.get('cache-control')).not.toContain('public')
    expect(first.headers.get('cache-control')).not.toContain('immutable')
    expect(first.headers.get('vary')).toContain('Cookie')

    const second = await handleImgProxyGet(request, {
      fetchImpl,
      cacheDir: tempDir,
      now: () => new Date('2026-05-11T00:00:00.000Z'),
      resolveHost: resolvePublicHost,
    })
    expect(second.status).toBe(200)
    expect(second.headers.get('x-img-proxy-cache')).toBe('HIT')
    expect(second.headers.get('cache-control')).toContain('private')
    expect(second.headers.get('cache-control')).not.toContain('public')
    expect(second.headers.get('cache-control')).not.toContain('immutable')
    expect(second.headers.get('vary')).toContain('Cookie')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const unauthenticated = await handleImgProxyGet(makeRequest('https://pbs.twimg.com/avatar.png'), {
      fetchImpl,
      cacheDir: tempDir,
      now: () => new Date('2026-05-11T00:00:00.000Z'),
      resolveHost: resolvePublicHost,
    })
    expect(unauthenticated.status).toBe(401)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
