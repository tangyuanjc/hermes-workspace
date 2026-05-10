import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import net from 'node:net'

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const CACHE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

type ImgProxyFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

type ImgProxyOptions = {
  fetchImpl?: ImgProxyFetch
  cacheDir?: string
  now?: () => Date
}

type CacheMeta = {
  url: string
  content_type: string
  size_bytes: number
  saved_at: string
}

function resolveCacheDir(cacheDir?: string) {
  if (cacheDir?.trim()) return cacheDir.trim()
  const explicit = process.env.HERMES_IMG_PROXY_CACHE_DIR?.trim()
  if (explicit) return explicit
  return path.join(os.homedir(), '.hermes', 'cache', 'aihot-img-proxy')
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64').toString('utf8')
}

function isPrivateHostname(hostname: string) {
  const lower = hostname.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.local')) return true
  const ipVersion = net.isIP(lower)
  if (ipVersion === 0) return false
  if (lower === '::1') return true
  if (lower.startsWith('127.')) return true
  if (lower.startsWith('10.')) return true
  if (lower.startsWith('192.168.')) return true
  const octets = lower.split('.').map((part) => Number.parseInt(part, 10))
  if (octets.length === 4 && octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true
  return false
}

function parseTargetUrl(request: Request) {
  const encoded = new URL(request.url).searchParams.get('u')?.trim()
  if (!encoded) return { ok: false as const, status: 400, error: 'Missing u parameter' }

  try {
    const decoded = decodeBase64Url(encoded)
    const parsed = new URL(decoded)
    if (parsed.protocol !== 'https:') return { ok: false as const, status: 403, error: 'Only https image URLs are allowed' }
    if (isPrivateHostname(parsed.hostname)) return { ok: false as const, status: 403, error: 'Private hosts are not allowed' }
    return { ok: true as const, url: parsed }
  } catch {
    return { ok: false as const, status: 400, error: 'Invalid encoded URL' }
  }
}

function cachePaths(cacheDir: string, targetUrl: string) {
  const key = createHash('sha256').update(targetUrl).digest('hex')
  return {
    bodyPath: path.join(cacheDir, `${key}.bin`),
    metaPath: path.join(cacheDir, `${key}.json`),
  }
}

function readCache(cacheDir: string, targetUrl: string, now: Date) {
  const paths = cachePaths(cacheDir, targetUrl)
  if (!fs.existsSync(paths.bodyPath) || !fs.existsSync(paths.metaPath)) return null

  try {
    const meta = JSON.parse(fs.readFileSync(paths.metaPath, 'utf8')) as CacheMeta
    if (meta.url !== targetUrl) return null
    if (now.getTime() - Date.parse(meta.saved_at) > CACHE_TTL_MS) return null
    if (!meta.content_type.startsWith('image/')) return null
    const body = fs.readFileSync(paths.bodyPath)
    if (body.byteLength > MAX_IMAGE_BYTES) return null
    return { body, contentType: meta.content_type }
  } catch {
    return null
  }
}

function writeCache(cacheDir: string, targetUrl: string, contentType: string, body: Buffer, now: Date) {
  fs.mkdirSync(cacheDir, { recursive: true })
  const paths = cachePaths(cacheDir, targetUrl)
  const meta: CacheMeta = {
    url: targetUrl,
    content_type: contentType,
    size_bytes: body.byteLength,
    saved_at: now.toISOString(),
  }
  fs.writeFileSync(paths.bodyPath, body)
  fs.writeFileSync(paths.metaPath, JSON.stringify(meta, null, 2), 'utf8')
}

function imageResponse(body: Buffer, contentType: string, cacheStatus: 'HIT' | 'MISS') {
  const responseBody = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
  return new Response(responseBody, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(body.byteLength),
      'Cache-Control': `public, max-age=${CACHE_MAX_AGE_SECONDS}, immutable`,
      'X-Img-Proxy-Cache': cacheStatus,
    },
  })
}

function errorResponse(status: number, error: string) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function contentTypeOf(response: Response) {
  return response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
}

function contentLengthOf(response: Response) {
  const raw = response.headers.get('content-length')
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : null
}

export async function handleImgProxyGet(request: Request, options: ImgProxyOptions = {}): Promise<Response> {
  const parsed = parseTargetUrl(request)
  if (!parsed.ok) return errorResponse(parsed.status, parsed.error)

  const now = options.now?.() ?? new Date()
  const cacheDir = resolveCacheDir(options.cacheDir)
  const targetUrl = parsed.url.toString()
  const cached = readCache(cacheDir, targetUrl, now)
  if (cached) return imageResponse(cached.body, cached.contentType, 'HIT')

  const fetchImpl = options.fetchImpl ?? fetch
  const upstream = await fetchImpl(parsed.url, {
    headers: {
      Accept: 'image/*',
      'User-Agent': 'aihot-img-proxy/1.0',
    },
    signal: AbortSignal.timeout(10_000),
  })

  if (!upstream.ok) return errorResponse(502, 'Upstream image fetch failed')

  const contentType = contentTypeOf(upstream)
  if (!contentType.startsWith('image/')) return errorResponse(403, 'Upstream content is not an image')

  const contentLength = contentLengthOf(upstream)
  if (contentLength !== null && contentLength > MAX_IMAGE_BYTES) {
    return errorResponse(413, 'Image exceeds 5MB limit')
  }

  const arrayBuffer = await upstream.arrayBuffer()
  if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
    return errorResponse(413, 'Image exceeds 5MB limit')
  }

  const body = Buffer.from(arrayBuffer)
  writeCache(cacheDir, targetUrl, contentType, body, now)
  return imageResponse(body, contentType, 'MISS')
}
