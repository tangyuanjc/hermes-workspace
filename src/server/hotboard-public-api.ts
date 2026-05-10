import { createHash } from 'node:crypto'
import { json } from '@tanstack/react-start'
import { getSessionUser, isAuthenticated } from './auth-middleware'
import { normalizeRole } from './auth-roles'
import { loadHotboardFeedEvents, type HotboardFeedEvent } from './hotboard-feed-api'
import { listRecentArticles, type WechatArticleRecord } from './hotboard-wechat-store'
import { createZaraStore } from './hotboard-zara-store'
import type { ZaraYoutubeItem } from './hotboard-zara-types'
import { getClientIp, rateLimit } from './rate-limit'

type PublicView = 'owner' | 'member'
type PublicSourceTier = 'T1' | 'T1.5' | 'T2'
type DailySectionKey = 'models' | 'agents' | 'tools' | 'multimodal' | 'industry'

type InternalPublicHotboardItem = {
  public_id: string
  title: string
  source_id: string
  source_name: string
  source_tier: PublicSourceTier
  signal_score: number
  url: string
  timestamp: string
  summary: string
  section: DailySectionKey
}

export type PublicHotboardItem = {
  id: string
  title: string
  source: string
  source_tier: PublicSourceTier
  signal_score: number
  url: string
  timestamp: string
  summary: string
}

const PUBLIC_RATE_LIMIT_PER_MINUTE = 600
const PUBLIC_RATE_LIMIT_BURST = 40
const PUBLIC_RATE_LIMIT_WINDOW_MS = 60_000
const PUBLIC_MAX_LIMIT = 50
const PUBLIC_LOOKBACK_LIMIT = 500
const TANGYUANJC_HOST_SUFFIX = '.tangyuanjc.com'

const DAILY_SECTIONS: Array<{ key: DailySectionKey; title: string }> = [
  { key: 'models', title: '模型与基础设施' },
  { key: 'agents', title: 'Agent 与工作流' },
  { key: 'tools', title: '产品与工具' },
  { key: 'multimodal', title: '内容与多模态' },
  { key: 'industry', title: '行业观点与同行动作' },
]

function todayDateString() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
}

function normalizeDateParam(value: string | null) {
  const date = value?.trim() || 'today'
  if (date === 'today') return todayDateString()
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date
  return null
}

function normalizeLimitParam(value: string | null) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) return PUBLIC_MAX_LIMIT
  return Math.max(1, Math.min(PUBLIC_MAX_LIMIT, parsed))
}

function publicId(parts: string[]) {
  return `pub_${createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)}`
}

function toDateKey(timestamp: string) {
  const parsed = Date.parse(timestamp)
  if (Number.isNaN(parsed)) return timestamp.slice(0, 10)
  return new Date(parsed).toISOString().slice(0, 10)
}

function sectionForText(input: string): DailySectionKey {
  const text = input.toLowerCase()
  if (/模型|openai|anthropic|claude|gpt|qwen|deepseek|gemini|llm|基础设施|inference|benchmark/.test(text)) {
    return 'models'
  }
  if (/agent|workflow|工作流|自动化|codex|claude code|multi-agent|多 agent|多agent/.test(text)) {
    return 'agents'
  }
  if (/工具|产品|app|api|平台|saas|browser|搜索|copilot/.test(text)) {
    return 'tools'
  }
  if (/image|video|图片|视频|多模态|生成|sora|midjourney|runway|海报|素材/.test(text)) {
    return 'multimodal'
  }
  return 'industry'
}

function sourceTierFor(sourceId: string): PublicSourceTier {
  if (sourceId.includes('official')) return 'T1'
  if (sourceId.startsWith('x-')) return 'T2'
  return 'T2'
}

function clampScore(score: number, fallback: number) {
  if (!Number.isFinite(score)) return fallback
  return Math.max(0, Math.min(100, Math.round(score)))
}

function fromXEvent(event: HotboardFeedEvent): InternalPublicHotboardItem {
  const timestamp = event.created_at || new Date(event.timestamp_ms || 0).toISOString()
  const textForSection = `${event.title} ${event.summary} ${event.source_line}`
  return {
    public_id: publicId(['x', event.source, event.url, event.title, timestamp]),
    title: event.title,
    source_id: event.source,
    source_name: event.source_line,
    source_tier: sourceTierFor(event.source),
    signal_score: clampScore(event.signal_score, 80),
    url: event.url,
    timestamp,
    summary: event.summary,
    section: sectionForText(textForSection),
  }
}

function fromWechatArticle(article: WechatArticleRecord): InternalPublicHotboardItem {
  const timestamp = article.publish_time || article.fetched_at
  const sourceName = article.author?.trim() || '微信公众号'
  return {
    public_id: publicId(['wechat', article.url, article.title, timestamp]),
    title: article.title,
    source_id: 'wechat',
    source_name: sourceName,
    source_tier: 'T2',
    signal_score: 82,
    url: article.url,
    timestamp,
    summary: article.excerpt,
    section: sectionForText(`${article.title} ${article.excerpt} ${sourceName}`),
  }
}

function fromZaraItem(item: ZaraYoutubeItem): InternalPublicHotboardItem {
  const timestamp = item.firstSeenAt || item.lastRefreshedAt || ''
  const sourceName = item.channel?.trim() || 'Zara YouTube'
  return {
    public_id: publicId(['zara-youtube', item.url, item.title, timestamp]),
    title: item.title,
    source_id: 'zara-youtube',
    source_name: sourceName,
    source_tier: 'T2',
    signal_score: 85,
    url: item.url,
    timestamp,
    summary: item.description ?? '',
    section: sectionForText(`${item.title} ${item.description ?? ''} ${item.tags.join(' ')}`),
  }
}

function loadAllPublicItems() {
  const xItems = loadHotboardFeedEvents('all', PUBLIC_LOOKBACK_LIMIT).events.map(fromXEvent)
  const wechatItems = listRecentArticles(PUBLIC_LOOKBACK_LIMIT).map(fromWechatArticle)
  const zaraItems = createZaraStore().listAllItems(PUBLIC_LOOKBACK_LIMIT).map(fromZaraItem)
  return [...xItems, ...wechatItems, ...zaraItems]
    .filter((item) => item.title.trim() && item.timestamp.trim())
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
}

function resolvePublicView(request: Request): PublicView {
  const role = normalizeRole(getSessionUser(request)?.role)
  return role === 'owner' ? 'owner' : 'member'
}

function toPublicItem(item: InternalPublicHotboardItem, view: PublicView): PublicHotboardItem {
  return {
    id: item.public_id,
    title: item.title,
    source: view === 'owner' ? item.source_id : item.source_name,
    source_tier: item.source_tier,
    signal_score: item.signal_score,
    url: item.url,
    timestamp: item.timestamp,
    summary: item.summary,
  }
}

function corsHeaders(request: Request) {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    Vary: 'Origin, Cookie',
  })
  const origin = request.headers.get('origin')
  if (!origin) return headers

  try {
    const hostname = new URL(origin).hostname
    if (hostname === 'tangyuanjc.com' || hostname.endsWith(TANGYUANJC_HOST_SUFFIX)) {
      headers.set('Access-Control-Allow-Origin', origin)
      headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
      headers.set('Access-Control-Allow-Headers', 'Content-Type, User-Agent')
      headers.set('Access-Control-Max-Age', '600')
    }
  } catch {
    return headers
  }

  return headers
}

function publicJson(request: Request, body: unknown, init: ResponseInit = {}) {
  const headers = corsHeaders(request)
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  return json(body, { ...init, headers })
}

function publicApiGuard(request: Request): Response | null {
  if (!isAuthenticated(request)) {
    return publicJson(request, { ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const limitKey = `public-api:${getClientIp(request)}`
  const allowed = rateLimit(
    limitKey,
    PUBLIC_RATE_LIMIT_PER_MINUTE + PUBLIC_RATE_LIMIT_BURST,
    PUBLIC_RATE_LIMIT_WINDOW_MS,
  )
  if (!allowed) {
    return publicJson(request, { ok: false, error: 'Rate limited' }, { status: 503 })
  }

  return null
}

function itemsForDate(date: string) {
  return loadAllPublicItems().filter((item) => toDateKey(item.timestamp) === date)
}

export async function handlePublicItemsGet(request: Request): Promise<Response> {
  const guard = publicApiGuard(request)
  if (guard) return guard

  const url = new URL(request.url)
  const date = normalizeDateParam(url.searchParams.get('date'))
  if (!date) return publicJson(request, { ok: false, error: 'Invalid date' }, { status: 400 })

  const limit = normalizeLimitParam(url.searchParams.get('limit'))
  const view = resolvePublicView(request)
  const items = itemsForDate(date).slice(0, limit).map((item) => toPublicItem(item, view))

  return publicJson(request, { ok: true, date, count: items.length, view, items })
}

export async function handlePublicDailyGet(request: Request): Promise<Response> {
  const guard = publicApiGuard(request)
  if (guard) return guard

  const url = new URL(request.url)
  const date = normalizeDateParam(url.searchParams.get('date'))
  if (!date) return publicJson(request, { ok: false, error: 'Invalid date' }, { status: 400 })

  const view = resolvePublicView(request)
  const items = itemsForDate(date)
  const sections = DAILY_SECTIONS.map((section) => {
    const sectionItems = items
      .filter((item) => item.section === section.key)
      .map((item) => toPublicItem(item, view))
    return { ...section, count: sectionItems.length, items: sectionItems }
  })

  return publicJson(request, { ok: true, date, view, sections })
}

export async function handlePublicDailiesGet(request: Request): Promise<Response> {
  const guard = publicApiGuard(request)
  if (guard) return guard

  const today = todayDateString()
  const start = Date.parse(`${today}T00:00:00.000Z`)
  const counts = new Map<string, number>()
  loadAllPublicItems().forEach((item) => {
    const key = toDateKey(item.timestamp)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  })

  const dailies = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start - index * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    return { date, count: counts.get(date) ?? 0 }
  })

  return publicJson(request, { ok: true, dailies })
}

export async function handlePublicOptions(request: Request): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export function redirectPublicToAihot(request: Request, endpoint: 'items' | 'daily' | 'dailies'): Response {
  const url = new URL(request.url)
  url.pathname = `/api/aihot/${endpoint}`
  return Response.redirect(url.toString(), 308)
}
