import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { json } from '@tanstack/react-start'
import { z } from 'zod'
import { isAuthenticated } from './auth-middleware'
import { resolveXSignalLatestPath } from './source-registry'
import { X_SIGNAL_PAYLOAD_SCHEMA, type XSignalPayload, type XTweet } from '../types/x-signal-payload'

type XEventSource = 'x-bookmarks' | 'x-likes' | 'x-following' | 'x-for_you'
export type XSignalSource = XEventSource | 'all' | 'low-follower'
type XSignalCountKey = keyof XSignalPayload['counts']

type EmptyReason = 'no_data' | 'source_failure' | 'permission_denied'

type FeedMeta = {
  status: 'fresh' | 'stale'
  stale: boolean
  partial_failures: string[]
  empty_reason?: EmptyReason
  freshness_hours?: number
  last_success_at?: string | null
  source_failure_reason?: string | null
}

type FeedResult = {
  generated_at: string
  data_source: string
  fallback: boolean
  meta: FeedMeta
  empty_reason?: EmptyReason
  events: HotboardFeedEvent[]
}

type MockEvent = {
  id: string
  timestamp: string
  source_type: string
  source_name: string
  source_channel: string
  title: string
  summary: string
  tags: string[]
  signal_category: string
  aggregated_sources_count: number
  engagement: {
    likes: number
    dislikes: number
    bookmarks: number
  }
  recommend_reason: string
  suggested_action: string
}

type MockPayload = {
  generated_at: string
  note: string
  events: MockEvent[]
}

export type HotboardFeedEvent = {
  event_id: string
  source: XEventSource
  source_line: string
  source_user: string
  title: string
  summary: string
  signal_score: number
  likes: number
  retweets: number
  views: number
  replies: number
  created_at: string
  url: string
  timestamp_ms: number
  avatar_url?: string
  thumbnail_url?: string
  image_url?: string
}

const SOURCE_SCHEMA = z.enum(['x-bookmarks', 'x-likes', 'x-following', 'x-for_you', 'all', 'low-follower'])
const SOURCE_MAP: Record<XEventSource, XSignalCountKey> = {
  'x-bookmarks': 'bookmarks',
  'x-likes': 'likes',
  'x-following': 'following',
  'x-for_you': 'for_you',
}
const SOURCE_KEYS = Object.keys(SOURCE_MAP) as XEventSource[]
const DEFAULT_LIMIT = 30
const DEFAULT_FEED_FRESHNESS_HOURS = 24
const MOCK_FEED_FILE_NAME = ['ai_hotboard', 'mock_events.json'].join('_')

function resolveFeedFreshnessHours() {
  const configured = Number.parseFloat(process.env.HOTBOARD_FEED_FRESHNESS_HOURS ?? '')
  if (Number.isFinite(configured) && configured > 0) return configured
  return DEFAULT_FEED_FRESHNESS_HOURS
}

function resolveXSignalPath() {
  return resolveXSignalLatestPath()
}

function resolveLastGoodPath() {
  const explicit = process.env.HOTBOARD_FEED_LASTGOOD_PATH?.trim()
  if (explicit) return explicit
  return path.join(os.homedir(), '.hermes', 'data', 'hotboard-feed-lastgood.json')
}

function truncateSummary(input: string) {
  const normalized = input.trim().replace(/\s+/g, ' ')
  if (normalized.length <= 200) return normalized
  return `${normalized.slice(0, 200)}...`
}

function parseCreatedAt(value?: string) {
  if (!value) return 0
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return 0
  return timestamp
}

function inferSignalScore(tweet: XTweet, source: Exclude<XSignalSource, 'all'>) {
  const likes = tweet.likes ?? 0
  const retweets = tweet.retweets ?? 0
  const views = tweet.views ?? 0

  const weightedEngagement = Math.round(likes * 1.8 + retweets * 2.6 + views * 0.015)
  const sourceBonus =
    source === 'x-bookmarks'
      ? 16
      : source === 'x-following'
        ? 12
        : source === 'x-likes'
          ? 10
          : 8

  return Math.max(60, Math.min(99, 55 + sourceBonus + Math.min(weightedEngagement, 28)))
}

function lowFollowerProxyScore(event: HotboardFeedEvent) {
  return (event.replies + event.retweets) / Math.max(event.likes, 1)
}

function percentile(values: number[], percentileRank: number) {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileRank) - 1))
  return sorted[index] ?? 0
}

export function lowFollowerFilter(events: HotboardFeedEvent[]): HotboardFeedEvent[] {
  const eligible = events.filter(
    (event) => event.likes + event.retweets >= 30 && event.replies + event.retweets > event.likes * 5,
  )
  const cap = percentile(eligible.map(lowFollowerProxyScore), 0.95)

  return eligible.sort(
    (a, b) => Math.min(lowFollowerProxyScore(b), cap) - Math.min(lowFollowerProxyScore(a), cap),
  )
}

function normalizeSourceLine(tweet: XTweet) {
  const author = (tweet.author ?? '').trim()
  const name = (tweet.name ?? '').trim()

  if (author && name) return `@${author} · ${name}`
  if (author) return `@${author}`
  if (name) return name
  return '@unknown'
}

function normalizeSourceUser(tweet: XTweet) {
  return (tweet.source_user ?? '').trim()
}

function normalizeTitle(tweet: XTweet) {
  const summary = truncateSummary(tweet.text ?? '')
  if (summary.length === 0) return 'X 信号更新'
  if (summary.length <= 72) return summary
  return `${summary.slice(0, 72)}...`
}

function readStringField(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function inferMediaImageUrl(tweet: XTweet) {
  const media = (tweet as { media?: unknown }).media
  if (!Array.isArray(media)) return undefined

  for (const entry of media) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const type = typeof record.type === 'string' ? record.type.toLowerCase() : ''
    if (type && type !== 'photo' && !type.includes('image')) continue
    // Do not fall back to record.url: X emits /status/<id>/photo/N permalinks, not CDN image URLs.
    const url = readStringField(record, ['media_url_https', 'media_url'])
    if (url?.startsWith('https://')) return url
  }

  return undefined
}

function toHotboardEvent(
  tweet: XTweet,
  source: XEventSource,
  index: number,
): HotboardFeedEvent {
  const sourceUser = normalizeSourceUser(tweet)
  const tweetId = (tweet.id ?? '').trim() || `idx${index}`
  const eventId = `${source}-${sourceUser || 'self'}-${tweetId}`
  const createdAt = (tweet.created_at ?? '').trim()
  const timestampMs = parseCreatedAt(createdAt)
  const tweetRecord = tweet as Record<string, unknown>
  const avatarUrl = readStringField(tweetRecord, [
    'avatar_url',
    'profile_image_url',
    'profile_image_url_https',
    'author_avatar_url',
  ])
  const thumbnailUrl = readStringField(tweetRecord, ['thumbnail_url', 'thumbnailUrl'])
  const imageUrl = readStringField(tweetRecord, ['image_url', 'imageUrl']) ?? inferMediaImageUrl(tweet)

  return {
    event_id: eventId,
    source,
    source_line: normalizeSourceLine(tweet),
    source_user: sourceUser,
    title: normalizeTitle(tweet),
    summary: truncateSummary(tweet.text ?? '') || '暂无内容',
    signal_score: inferSignalScore(tweet, source),
    likes: tweet.likes ?? 0,
    retweets: tweet.retweets ?? 0,
    views: tweet.views ?? 0,
    replies: tweet.replies ?? 0,
    created_at: createdAt,
    url: (tweet.url ?? '').trim(),
    timestamp_ms: timestampMs,
    avatar_url: avatarUrl,
    thumbnail_url: thumbnailUrl,
    image_url: imageUrl,
  }
}

type ParseXSignalPayloadResult =
  | { ok: true; payload: XSignalPayload }
  | { ok: false; reason: 'invalid_x_signal_latest' | 'invalid_x_signal_schema' }

function hasValidCounts(payload: XSignalPayload) {
  if (payload.ok === false) return true

  return SOURCE_KEYS.every((key) => {
    const countValue = payload.counts[SOURCE_MAP[key]]
    const items = payload[SOURCE_MAP[key]]
    if (!countValue || !Array.isArray(items)) return true
    return countValue.total >= items.length
  })
}

function parseXSignalPayload(raw: string): ParseXSignalPayloadResult {
  try {
    const jsonValue = JSON.parse(raw) as unknown
    const parsed = X_SIGNAL_PAYLOAD_SCHEMA.safeParse(jsonValue)
    if (!parsed.success) return { ok: false, reason: 'invalid_x_signal_schema' }
    if (Number.isNaN(Date.parse(parsed.data.generated_at))) {
      return { ok: false, reason: 'invalid_x_signal_schema' }
    }
    const payload = parsed.data as XSignalPayload
    if (!hasValidCounts(payload)) return { ok: false, reason: 'invalid_x_signal_schema' }
    return { ok: true, payload }
  } catch {
    return { ok: false, reason: 'invalid_x_signal_latest' }
  }
}

function isStaleGeneratedAt(value: string, freshnessHours = resolveFeedFreshnessHours()) {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return true
  return Date.now() - timestamp > freshnessHours * 60 * 60 * 1000
}

function buildXSignalMeta(parsed: XSignalPayload): FeedMeta {
  const partialFailures = Object.keys(parsed.errors ?? {})
  const freshnessHours = resolveFeedFreshnessHours()
  const stale = isStaleGeneratedAt(parsed.generated_at, freshnessHours)
  return {
    status: stale ? 'stale' : 'fresh',
    stale,
    freshness_hours: freshnessHours,
    partial_failures: parsed.ok === false && partialFailures.length === 0 ? ['unknown'] : partialFailures,
    last_success_at: parsed.generated_at,
  }
}

function emptyMeta(): FeedMeta {
  return { status: 'fresh', stale: false, partial_failures: [] }
}

function shouldEnableMockFallback() {
  return process.env.HOTBOARD_ENABLE_MOCK_FEED_FALLBACK === '1'
}

function sourceFailureMeta(reason: string, lastSuccessAt: string | null = null): FeedMeta {
  return {
    status: 'stale',
    stale: true,
    partial_failures: [reason],
    empty_reason: 'source_failure',
    last_success_at: lastSuccessAt,
    source_failure_reason: reason,
  }
}

function emptyXFeedResult(xSignalPath: string, reason?: string, emptyReason: EmptyReason = 'no_data'): FeedResult {
  return {
    generated_at: new Date().toISOString(),
    data_source: path.basename(xSignalPath),
    fallback: false,
    meta: reason ? sourceFailureMeta(reason) : { ...emptyMeta(), empty_reason: emptyReason },
    empty_reason: reason ? 'source_failure' : emptyReason,
    events: [],
  }
}

function buildFeedResultFromPayload({
  parsed,
  source,
  limit,
  xSignalPath,
  meta,
  emptyReason,
}: {
  parsed: XSignalPayload
  source: XSignalSource
  limit: number
  xSignalPath: string
  meta: FeedMeta
  emptyReason?: EmptyReason
}): FeedResult {
  const build = (key: XEventSource) => {
    const items = (parsed[SOURCE_MAP[key]] ?? []) as XTweet[]
    return items.map((tweet, index) => toHotboardEvent(tweet, key, index))
  }

  const events =
    source === 'all'
      ? SOURCE_KEYS.flatMap((key) => build(key)).sort((a, b) => b.timestamp_ms - a.timestamp_ms)
      : source === 'low-follower'
        ? lowFollowerFilter(SOURCE_KEYS.flatMap((key) => build(key)))
      : build(source)
  const partialFailures = meta.partial_failures
  const isAllSourceFailure = events.length === 0 && partialFailures.length > 0
  const resolvedEmptyReason = events.length === 0 ? (isAllSourceFailure ? 'source_failure' : emptyReason) : undefined
  const resolvedMeta: FeedMeta = isAllSourceFailure
    ? {
        ...meta,
        status: 'stale',
        stale: true,
        empty_reason: 'source_failure',
        source_failure_reason: partialFailures.join(', '),
      }
    : events.length === 0 && emptyReason
      ? { ...meta, empty_reason: emptyReason }
      : meta

  return {
    generated_at: parsed.generated_at,
    data_source: path.basename(xSignalPath),
    fallback: false,
    meta: resolvedMeta,
    empty_reason: resolvedEmptyReason,
    events: events.slice(0, limit),
  }
}

function readLastGoodPayload(): XSignalPayload | null {
  const lastGoodPath = resolveLastGoodPath()
  if (!fs.existsSync(lastGoodPath)) return null
  try {
    const raw = fs.readFileSync(lastGoodPath, 'utf-8')
    const parsed = JSON.parse(raw) as { payload?: unknown }
    if (!parsed.payload) return null
    const result = parseXSignalPayload(JSON.stringify(parsed.payload))
    return result.ok ? result.payload : null
  } catch {
    return null
  }
}

function writeLastGoodPayload(payload: XSignalPayload) {
  const lastGoodPath = resolveLastGoodPath()
  fs.mkdirSync(path.dirname(lastGoodPath), { recursive: true })
  fs.writeFileSync(lastGoodPath, JSON.stringify({ saved_at: new Date().toISOString(), payload }, null, 2), 'utf-8')
}

function staleLastGoodResult(source: XSignalSource, limit: number, xSignalPath: string, reason: string): FeedResult {
  const lastGood = readLastGoodPayload()
  if (!lastGood) return emptyXFeedResult(xSignalPath, reason, 'source_failure')

  return buildFeedResultFromPayload({
    parsed: lastGood,
    source,
    limit,
    xSignalPath,
    meta: sourceFailureMeta(reason, lastGood.generated_at),
    emptyReason: 'source_failure',
  })
}

function loadXFeedEvents(source: XSignalSource, limit = DEFAULT_LIMIT): FeedResult {
  const xSignalPath = resolveXSignalPath()
  if (!fs.existsSync(xSignalPath)) return staleLastGoodResult(source, limit, xSignalPath, 'missing_x_signal_latest')

  const raw = fs.readFileSync(xSignalPath, 'utf-8')
  const parsed = parseXSignalPayload(raw)
  if (!parsed.ok) return staleLastGoodResult(source, limit, xSignalPath, parsed.reason)

  const result = buildFeedResultFromPayload({
    parsed: parsed.payload,
    source,
    limit,
    xSignalPath,
    meta: buildXSignalMeta(parsed.payload),
    emptyReason: 'no_data',
  })

  if (result.events.length > 0) writeLastGoodPayload(parsed.payload)
  return result
}

export function loadHotboardFeedEvents(source: XSignalSource = 'all', limit = DEFAULT_LIMIT) {
  return loadXFeedEvents(source, limit)
}

function loadMockPayload(): MockPayload {
  const modulePath = fileURLToPath(
    new URL(`../screens/ai-hotboard/${MOCK_FEED_FILE_NAME}`, import.meta.url),
  )
  const raw = fs.readFileSync(modulePath, 'utf-8')
  return JSON.parse(raw) as MockPayload
}

function mapMockSource(source: XSignalSource): XEventSource {
  if (source !== 'all' && source !== 'low-follower') return source
  return 'x-bookmarks'
}

function selectFallbackEvents(payload: MockPayload, source: XSignalSource) {
  if (source === 'all') {
    return payload.events
  }

  const channelKeyword =
    source === 'x-bookmarks'
      ? 'bookmarks'
      : source === 'x-likes'
        ? 'likes'
        : source === 'x-following'
          ? 'following'
          : 'for_you'

  const filtered = payload.events.filter((event) => {
    const channel = `${event.source_name} ${event.source_channel}`.toLowerCase()
    return channel.includes(channelKeyword)
  })

  return filtered.length > 0 ? filtered : payload.events
}

function loadFallbackEvents(source: XSignalSource, limit = DEFAULT_LIMIT): FeedResult {
  const payload = loadMockPayload()
  const mappedSource = mapMockSource(source)
  const selectedEvents = selectFallbackEvents(payload, source)

  const events = selectedEvents.map((event) => ({
    event_id: event.id,
    source: mappedSource,
    source_line: `${event.source_type} · ${event.source_name} · ${event.source_channel}`,
    source_user: '',
    title: event.title,
    summary: truncateSummary(event.summary),
    signal_score: Math.max(
      60,
      Math.min(99, 58 + Math.round(event.engagement.likes * 0.15 + event.engagement.bookmarks * 0.25)),
    ),
    likes: event.engagement.likes,
    retweets: 0,
    views: 0,
    replies: 0,
    created_at: event.timestamp,
    url: '',
    timestamp_ms: 0,
  }))

  return {
    generated_at: payload.generated_at,
    data_source: MOCK_FEED_FILE_NAME,
    fallback: true,
    meta: emptyMeta(),
    events: events.slice(0, limit),
  }
}

export async function handleHotboardFeedGet(request: Request): Promise<Response> {
  if (!isAuthenticated(request)) {
    return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const sourceParam = url.searchParams.get('source') ?? 'all'
  const parsedSource = SOURCE_SCHEMA.safeParse(sourceParam)
  if (!parsedSource.success) {
    return json({ ok: false, error: 'Invalid source query parameter' }, { status: 400 })
  }

  const source = parsedSource.data as XSignalSource
  const xFeed = loadXFeedEvents(source)
  const result = xFeed.events.length === 0 && xFeed.empty_reason === 'source_failure' && shouldEnableMockFallback()
    ? loadFallbackEvents(source)
    : xFeed

  return json({
    ok: true,
    source,
    count: result.events.length,
    generated_at: result.generated_at,
    data_source: result.data_source,
    fallback: result.fallback,
    empty_reason: result.empty_reason,
    meta: result.meta,
    events: result.events,
  })
}
