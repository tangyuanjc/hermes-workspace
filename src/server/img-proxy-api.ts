import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import net from 'node:net'
import { lookup } from 'node:dns/promises'
import { isAuthenticated } from './auth-middleware'

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const CACHE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

type ImgProxyFetch = (input: string | URL, init?: RequestInit) => Promise<Response>
type HostResolver = (hostname: string) => Promise<string[]>

type ImgProxyOptions = {
  fetchImpl?: ImgProxyFetch
  cacheDir?: string
  now?: () => Date
  resolveHost?: HostResolver
}

type CacheMeta = {
  url: string
  content_type: string
  size_bytes: number
  saved_at: string
}

const ALLOWED_IMAGE_HOSTS = new Set([
  'pbs.twimg.com',
  'abs.twimg.com',
  'ton.twimg.com',
  'mmbiz.qpic.cn',
  'i.ytimg.com',
  'yt3.ggpht.com',
  'img.youtube.com',
  'i.scdn.co',
])

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

function normalizedHostname(hostname: string) {
  return hostname.toLowerCase().replace(/\.$/, '')
}

function isPrivateIpv4(address: string) {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10))
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [first, second] = octets
  if (first === 0 || first === 10 || first === 127) return true
  if (first === 100 && second >= 64 && second <= 127) return true
  if (first === 169 && second === 254) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  if (first >= 224) return true
  return false
}

function isPrivateIpv6(address: string) {
  const lower = address.toLowerCase()
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateIpv4(mapped[1])
  if (lower === '::' || lower === '::1') return true
  const firstHextet = Number.parseInt(lower.split(':')[0] || '0', 16)
  if (!Number.isFinite(firstHextet)) return true
  if ((firstHextet & 0xfe00) === 0xfc00) return true
  if ((firstHextet & 0xffc0) === 0xfe80) return true
  return false
}

function isPrivateAddress(address: string) {
  const version = net.isIP(address)
  if (version === 4) return isPrivateIpv4(address)
  if (version === 6) return isPrivateIpv6(address)
  return true
}

async function resolveHostAddresses(hostname: string, resolveHost?: HostResolver) {
  if (net.isIP(hostname)) return [hostname]
  if (resolveHost) return resolveHost(hostname)
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

function parseTargetUrl(request: Request) {
  const encoded = new URL(request.url).searchParams.get('u')?.trim()
  if (!encoded) return { ok: false as const, status: 400, error: 'Missing u parameter' }

  try {
    const decoded = decodeBase64Url(encoded)
    const parsed = new URL(decoded)
    return { ok: true as const, url: parsed }
  } catch {
    return { ok: false as const, status: 400, error: 'Invalid encoded URL' }
  }
}

async function validateTargetUrl(url: URL, resolveHost?: HostResolver) {
  if (url.protocol !== 'https:') return { ok: false as const, status: 403, error: 'Only https image URLs are allowed' }

  const hostname = normalizedHostname(url.hostname)
  if (!ALLOWED_IMAGE_HOSTS.has(hostname)) {
    return { ok: false as const, status: 403, error: 'Image host is not allowed' }
  }

  let addresses: string[]
  try {
    addresses = await resolveHostAddresses(hostname, resolveHost)
  } catch {
    return { ok: false as const, status: 403, error: 'Image host failed DNS validation' }
  }

  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    return { ok: false as const, status: 403, error: 'Image host resolved to a private address' }
  }

  return { ok: true as const, url }
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
    if (!meta.content_type.startsWith('image/') || meta.content_type === 'image/svg+xml') return null
    const body = fs.readFileSync(paths.bodyPath)
    if (body.byteLength > MAX_IMAGE_BYTES) return null
    const detectedContentType = detectBitmapContentType(body)
    if (!detectedContentType) return null
    return { body, contentType: detectedContentType }
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

function imageExtension(contentType: string) {
  if (contentType === 'image/jpeg') return 'jpg'
  if (contentType === 'image/png') return 'png'
  if (contentType === 'image/webp') return 'webp'
  if (contentType === 'image/gif') return 'gif'
  return 'bin'
}

function safeFilename(targetUrl: string, contentType: string) {
  let filename = `image.${imageExtension(contentType)}`
  try {
    const basename = path.posix.basename(new URL(targetUrl).pathname)
    if (basename && basename !== '/') filename = decodeURIComponent(basename)
  } catch {
    filename = `image.${imageExtension(contentType)}`
  }

  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 120)
  if (!safe) return `image.${imageExtension(contentType)}`
  if (!safe.includes('.')) return `${safe}.${imageExtension(contentType)}`
  return safe
}

function imageResponse(body: Buffer, contentType: string, cacheStatus: 'HIT' | 'MISS', targetUrl: string) {
  const responseBody = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
  return new Response(responseBody, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(body.byteLength),
      'Cache-Control': `public, max-age=${CACHE_MAX_AGE_SECONDS}, immutable`,
      'X-Img-Proxy-Cache': cacheStatus,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="${safeFilename(targetUrl, contentType)}"`,
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

function detectBitmapContentType(body: Buffer) {
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg'
  if (body.length >= 4 && body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) return 'image/png'
  if (body.length >= 4 && body.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (
    body.length >= 12 &&
    body.subarray(0, 4).toString('ascii') === 'RIFF' &&
    body.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp'
  return null
}

async function readImageBody(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) {
    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) return { ok: false as const, status: 413, error: 'Image exceeds 5MB limit' }
    return { ok: true as const, body: Buffer.from(arrayBuffer) }
  }

  const chunks: Buffer[] = []
  let totalBytes = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue

    totalBytes += value.byteLength
    if (totalBytes > MAX_IMAGE_BYTES) {
      await reader.cancel()
      return { ok: false as const, status: 413, error: 'Image exceeds 5MB limit' }
    }
    chunks.push(Buffer.from(value))
  }

  return { ok: true as const, body: Buffer.concat(chunks, totalBytes) }
}

function isRedirectResponse(response: Response) {
  return response.status >= 300 && response.status < 400
}

async function fetchValidatedImage(
  url: URL,
  fetchImpl: ImgProxyFetch,
  resolveHost: HostResolver | undefined,
  redirectsRemaining: number,
): Promise<{ ok: true; response: Response } | { ok: false; status: number; error: string }> {
  const validated = await validateTargetUrl(url, resolveHost)
  if (!validated.ok) return validated

  const response = await fetchImpl(validated.url, {
    headers: {
      Accept: 'image/*',
      'User-Agent': 'aihot-img-proxy/1.0',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  })

  if (!isRedirectResponse(response)) return { ok: true, response }
  if (redirectsRemaining <= 0) return { ok: false, status: 403, error: 'Too many image redirects' }

  const location = response.headers.get('location')
  if (!location) return { ok: false, status: 403, error: 'Image redirect is missing location' }

  let redirectedUrl: URL
  try {
    redirectedUrl = new URL(location, validated.url)
  } catch {
    return { ok: false, status: 403, error: 'Image redirect location is invalid' }
  }

  return fetchValidatedImage(redirectedUrl, fetchImpl, resolveHost, redirectsRemaining - 1)
}

export async function handleImgProxyGet(request: Request, options: ImgProxyOptions = {}): Promise<Response> {
  if (!isAuthenticated(request)) return errorResponse(401, 'Unauthorized')

  const parsed = parseTargetUrl(request)
  if (!parsed.ok) return errorResponse(parsed.status, parsed.error)

  const validated = await validateTargetUrl(parsed.url, options.resolveHost)
  if (!validated.ok) return errorResponse(validated.status, validated.error)

  const now = options.now?.() ?? new Date()
  const cacheDir = resolveCacheDir(options.cacheDir)
  const targetUrl = validated.url.toString()
  const cached = readCache(cacheDir, targetUrl, now)
  if (cached) return imageResponse(cached.body, cached.contentType, 'HIT', targetUrl)

  const fetchImpl = options.fetchImpl ?? fetch
  const fetched = await fetchValidatedImage(validated.url, fetchImpl, options.resolveHost, 2)
  if (!fetched.ok) return errorResponse(fetched.status, fetched.error)

  const upstream = fetched.response

  if (!upstream.ok) return errorResponse(502, 'Upstream image fetch failed')

  const contentType = contentTypeOf(upstream)
  if (contentType === 'image/svg+xml') return errorResponse(403, 'SVG images are not allowed')
  if (!contentType.startsWith('image/')) return errorResponse(403, 'Upstream content is not an image')

  const contentLength = contentLengthOf(upstream)
  if (contentLength !== null && contentLength > MAX_IMAGE_BYTES) {
    return errorResponse(413, 'Image exceeds 5MB limit')
  }

  const bodyResult = await readImageBody(upstream)
  if (!bodyResult.ok) return errorResponse(bodyResult.status, bodyResult.error)

  const body = bodyResult.body
  const detectedContentType = detectBitmapContentType(body)
  if (!detectedContentType) return errorResponse(403, 'Upstream image magic bytes are not allowed')

  writeCache(cacheDir, targetUrl, detectedContentType, body, now)
  return imageResponse(body, detectedContentType, 'MISS', targetUrl)
}
