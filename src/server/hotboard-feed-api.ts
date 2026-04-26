import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { json } from '@tanstack/react-start'
import { z } from 'zod'
import { isAuthenticated } from './auth-middleware'

type XEventSource = 'x-bookmarks' | 'x-likes' | 'x-following' | 'x-for_you'
type XSignalSource = XEventSource | 'all' | 'low-follower'

type XTweet = {
  id?: string
  author?: string
  name?: string
  source_user?: string
  text?: string
  likes?: number
  retweets?: number
  views?: number
  replies?: number
  created_at?: string
  url?: string
}

type XSignalPayload = {
  ok?: boolean
  errors?: Record<string, unknown>
  counts?: Record<string, number>
  bookmarks?: XTweet[]
  likes?: XTweet[]
  following?: XTweet[]
  for_you?: XTweet[]
  generated_at?: string
}

type FeedMeta = {
  stale: boolean
  partial_failures: string[]
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

type HotboardFeedEvent = {
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
}

const DEFAULT_X_SIGNAL_PATH = path.join(os.homedir(), '.hermes', 'tmp', 'x_signal_sync_latest.json')
const SOURCE_SCHEMA = z.enum(['x-bookmarks', 'x-likes', 'x-following', 'x-for_you', 'all', 'low-follower'])
const SOURCE_MAP: Record<XEventSource, keyof XSignalPayload> = {
  'x-bookmarks': 'bookmarks',
  'x-likes': 'likes',
  'x-following': 'following',
  'x-for_you': 'for_you',
}
const SOURCE_KEYS = Object.keys(SOURCE_MAP) as XEventSource[]
const DEFAULT_LIMIT = 30
const X_SIGNAL_STALE_MS = 24 * 60 * 60 * 1000
const MOCK_FEED_FILE_NAME = ['ai_hotboard', 'mock_events.json'].join('_')

function resolveXSignalPath() {
  return process.env.HOTBOARD_X_SIGNAL_PATH || DEFAULT_X_SIGNAL_PATH
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
  }
}

function parseXSignalPayload(raw: string): XSignalPayload | null {
  try {
    const parsed = JSON.parse(raw) as XSignalPayload
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function isStaleGeneratedAt(value?: string) {
  if (!value) return false
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return true
  return Date.now() - timestamp > X_SIGNAL_STALE_MS
}

function buildXSignalMeta(parsed: XSignalPayload): FeedMeta {
  const partialFailures = Object.keys(parsed.errors ?? {})
  return {
    stale: isStaleGeneratedAt(parsed.generated_at),
    partial_failures: parsed.ok === false && partialFailures.length === 0 ? ['unknown'] : partialFailures,
  }
}

function emptyMeta(): FeedMeta {
  return { stale: false, partial_failures: [] }
}

function loadXFeedEvents(source: XSignalSource, limit = DEFAULT_LIMIT) {
  const xSignalPath = resolveXSignalPath()
  if (!fs.existsSync(xSignalPath)) return null

  const raw = fs.readFileSync(xSignalPath, 'utf-8')
  const parsed = parseXSignalPayload(raw)
  if (!parsed) return null

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

  if (events.length === 0) return null

  return {
    generated_at: parsed.generated_at ?? new Date().toISOString(),
    data_source: path.basename(xSignalPath),
    fallback: false,
    meta: buildXSignalMeta(parsed),
    events: events.slice(0, limit),
  }
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

function loadFallbackEvents(source: XSignalSource, limit = DEFAULT_LIMIT) {
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
  const result = xFeed ?? loadFallbackEvents(source)

  return json({
    ok: true,
    source,
    count: result.events.length,
    generated_at: result.generated_at,
    data_source: result.data_source,
    fallback: result.fallback,
    meta: result.meta,
    events: result.events,
  })
}
