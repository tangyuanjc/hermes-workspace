import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleImgProxyGet } from './img-proxy-api'

let tempDir = ''

function encodeUrl(url: string) {
  return Buffer.from(url, 'utf8').toString('base64')
}

function makeRequest(url: string) {
  return new Request(`http://localhost/api/img-proxy?u=${encodeURIComponent(encodeUrl(url))}`)
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-proxy-api-'))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('img proxy API', () => {
  it('rejects non-https URLs for SSRF protection', async () => {
    const response = await handleImgProxyGet(makeRequest('http://internal-service/image.png'), { cacheDir: tempDir })
    expect(response.status).toBe(403)
  })

  it('rejects non-image content types', async () => {
    const fetchImpl = vi.fn(async () => new Response('hello', { headers: { 'content-type': 'text/html' } }))
    const response = await handleImgProxyGet(makeRequest('https://example.com/page'), { fetchImpl, cacheDir: tempDir })

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
    const response = await handleImgProxyGet(makeRequest('https://example.com/huge.png'), { fetchImpl, cacheDir: tempDir })

    expect(response.status).toBe(413)
  })

  it('caches valid images on disk for subsequent requests', async () => {
    const body = new Uint8Array([137, 80, 78, 71])
    const fetchImpl = vi.fn(async () => new Response(body, { headers: { 'content-type': 'image/png' } }))
    const request = makeRequest('https://cdn.example.com/avatar.png')

    const first = await handleImgProxyGet(request, { fetchImpl, cacheDir: tempDir, now: () => new Date('2026-05-10T00:00:00.000Z') })
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/png')
    expect(first.headers.get('x-img-proxy-cache')).toBe('MISS')

    const second = await handleImgProxyGet(request, { fetchImpl, cacheDir: tempDir, now: () => new Date('2026-05-11T00:00:00.000Z') })
    expect(second.status).toBe(200)
    expect(second.headers.get('x-img-proxy-cache')).toBe('HIT')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
