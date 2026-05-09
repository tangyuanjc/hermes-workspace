import { Link } from '@tanstack/react-router'
import {
  ActivitySparkIcon,
  AiSearchIcon,
  AnalyticsUpIcon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  Bookmark02Icon,
  LinkSquareIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
import { LoginScreen } from '@/components/auth/login-screen'
import { cn } from '@/lib/utils'
import { type AuthUser } from '@/lib/hermes-auth'
import { clearAiHotboardAuthCache, useAiHotboardAuth } from './ai-hotboard-auth'
import {
  buildFeedFallbackPayload,
  mapFeedEventToMockEvent,
  normalizeTimelineTimestamp,
  parseGeneratedAtValue,
  toSupportedHotboardSource,
  type MockEvent,
} from './ai-hotboard-feed-adapter'
import {
  getHotboardRouteChrome,
  normalizeHotboardPage,
  resolveHotboardPageFromSource,
  resolveSourceByHotboardPage,
  type AiHotboardPage,
  type SourcePageKey,
} from './ai-hotboard-route-config'

type MockPayload = {
  generated_at: string
  note: string
  events: MockEvent[]
}

const EMPTY_MOCK_PAYLOAD: MockPayload = {
  generated_at: new Date(0).toISOString(),
  note: 'empty-feed',
  events: [],
}

type FeedMeta = {
  status?: 'fresh' | 'stale'
  stale: boolean
  partial_failures: string[]
  empty_reason?: 'no_data' | 'source_failure' | 'permission_denied'
  last_success_at?: string | null
  source_failure_reason?: string | null
}

type SeenEventStorage = Pick<Storage, 'getItem' | 'setItem'>

export type TimelineEvent = MockEvent & {
  id: string
  signalScore: number
  actionLine: string
  recommendReasonLine: string
  condensedSourceLabel: string
  aggregatedSourcesLabel: string | null
}

type TimelineGroup = {
  timestamp: string
  events: TimelineEvent[]
}

const DATA_SOURCE_LABEL = ['ai_hotboard', 'mock_events.json'].join('_')
const STRATEGY_GLOSSARY_SOURCE_LABEL = '~/.org/shared-memory/business-glossary.md'
const EMPTY_FEED_META: FeedMeta = { status: 'fresh', stale: false, partial_failures: [] }
export const SEEN_EVENT_STORAGE_LIMIT = 1000
export const SEEN_EVENT_DWELL_MS = 2500

export function hashUserId(userId: string) {
  const value = userId.trim() || 'unknown-user'
  let hash = 5381

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0
  }

  return hash.toString(36).slice(0, 12)
}

export function getSeenEventStorageKey(userId: string) {
  return `ai-hotboard-seen-${hashUserId(userId)}`
}

function getSeenEventStorage(): SeenEventStorage | null {
  if (typeof window === 'undefined') return null
  return window.localStorage
}

export function parseSeenEventIds(raw: string | null): string[] {
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw) as unknown
    const values = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { ids?: unknown }).ids)
      ? (parsed as { ids: unknown[] }).ids
      : []
    const seen = new Set<string>()
    const ids: string[] = []

    values.forEach((value) => {
      const id = typeof value === 'string' ? value.trim() : ''
      if (!id || seen.has(id)) return
      seen.add(id)
      ids.push(id)
    })

    return ids
  } catch {
    return []
  }
}

export function mergeSeenEventIds(
  existingIds: Iterable<string>,
  incomingIds: Iterable<string>,
  limit = SEEN_EVENT_STORAGE_LIMIT,
) {
  const merged: string[] = []
  const seen = new Set<string>()

  for (const value of existingIds) {
    const id = value.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    merged.push(id)
  }

  for (const value of incomingIds) {
    const id = value.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    merged.push(id)
  }

  return merged.slice(Math.max(0, merged.length - limit))
}

export function readSeenEventIds(userId: string, storage: SeenEventStorage | null = getSeenEventStorage()) {
  if (!storage) return new Set<string>()
  return new Set(parseSeenEventIds(storage.getItem(getSeenEventStorageKey(userId))))
}

export function writeSeenEventIds(
  userId: string,
  ids: Iterable<string>,
  storage: SeenEventStorage | null = getSeenEventStorage(),
) {
  const existingIds = storage ? parseSeenEventIds(storage.getItem(getSeenEventStorageKey(userId))) : []
  const nextIds = mergeSeenEventIds(existingIds, ids)
  if (storage) {
    storage.setItem(getSeenEventStorageKey(userId), JSON.stringify(nextIds))
  }
  return new Set(nextIds)
}

export function observeSeenEventDwell({
  root,
  onSeen,
  dwellMs = SEEN_EVENT_DWELL_MS,
}: {
  root: Document | Element
  onSeen: (eventId: string) => void
  dwellMs?: number
}) {
  if (typeof IntersectionObserver === 'undefined') return () => {}

  const timers = new Map<Element, ReturnType<typeof setTimeout>>()
  const marked = new Set<string>()
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const element = entry.target as HTMLElement
      const eventId = element.dataset.eventId?.trim()
      if (!eventId || marked.has(eventId)) return

      const isVisible = entry.isIntersecting && entry.intersectionRatio > 0
      const existingTimer = timers.get(element)

      if (!isVisible) {
        if (existingTimer) clearTimeout(existingTimer)
        timers.delete(element)
        return
      }

      if (existingTimer) return

      const timer = setTimeout(() => {
        timers.delete(element)
        marked.add(eventId)
        onSeen(eventId)
      }, dwellMs)
      timers.set(element, timer)
    })
  })

  root.querySelectorAll<HTMLElement>('[data-event-id]').forEach((element) => {
    observer.observe(element)
  })

  return () => {
    timers.forEach((timer) => clearTimeout(timer))
    timers.clear()
    observer.disconnect()
  }
}

export function normalizeFeedMeta(meta?: Partial<FeedMeta>): FeedMeta {
  const emptyReason =
    meta?.empty_reason === 'no_data' ||
    meta?.empty_reason === 'source_failure' ||
    meta?.empty_reason === 'permission_denied'
      ? meta.empty_reason
      : undefined

  return {
    status: meta?.status === 'stale' ? 'stale' : 'fresh',
    stale: meta?.stale === true,
    partial_failures: Array.isArray(meta?.partial_failures)
      ? meta.partial_failures.map((item) => String(item))
      : [],
    empty_reason: emptyReason,
    last_success_at: typeof meta?.last_success_at === 'string' ? meta.last_success_at : null,
    source_failure_reason: typeof meta?.source_failure_reason === 'string' ? meta.source_failure_reason : null,
  }
}

export type VoteType = 'like' | 'dislike' | 'bookmark'

export type VoteAggregateEntry = {
  like_count: number
  dislike_count: number
  bookmark_count: number
  my_vote: VoteType[]
}

export type VoteAggregateByEvent = Record<string, VoteAggregateEntry>

type FeedMode = 'featured' | 'all' | 'low-follower' | 'bookmarks'

type IntakeAgentKey = 'hermes' | 'xiaoj'

type IntakeItem = {
  id: string
  author_agent_id: IntakeAgentKey
  title: string
  body: string
  tags: string[]
  submitted_by_open_id: string
  submitted_by_name: string
  created_at: string
}

type StrategyStatusItem = {
  lineKey: string
  code: string
  name: string
  owner: string
  priority: string
}

type WechatArticleSummary = {
  id: string
  url: string
  title: string
  author: string | null
  publish_time: string | null
  excerpt: string
}

type ZaraYoutubeSummary = {
  videoId: string
  url: string
  title: string
  channel?: string
  tags: string[]
  description?: string
  thumbnailUrl?: string
  firstSeenAt?: string
  lastRefreshedAt?: string
}

type NavItem = {
  key: string
  label: string
  to: string
}

export const SOURCE_ITEMS = [
  'X bookmarks',
  'X likes',
  'X following',
  'X for_you',
  '公众号',
  'Zara YouTube 精选',
  'JC的人类对谈',
] as const

export const SOURCE_SUBMISSION_ITEMS = ['JC 苹果备忘录日记', '爱马仕战略发现', '小J 执行发现'] as const

export const X_SOURCE_ROUTE_ITEMS = [
  { key: 'x-bookmarks', label: 'X bookmarks', to: '/ai-hotboard/source/x-bookmarks' },
  { key: 'x-likes', label: 'X likes', to: '/ai-hotboard/source/x-likes' },
  { key: 'x-following', label: 'X following', to: '/ai-hotboard/source/x-following' },
  { key: 'x-for_you', label: 'X for_you', to: '/ai-hotboard/source/x-for_you' },
] as const

const SOURCE_PLACEHOLDER_ROUTE_ITEMS = [
  {
    key: 'jc-human-talks',
    label: 'JC的人类对谈',
    to: '/ai-hotboard/source/jc-human-talks',
    expectedWeek: '待定',
    owner: 'JC',
    dataSource: '飞书妙记精选片段 · JC 手工策展',
  },
] as const

const ZARA_SOURCE_ROUTE_ITEMS = [
  {
    key: 'zara-youtube',
    label: 'Zara YouTube 精选',
    to: '/ai-hotboard/source/zara-youtube',
  },
] as const

const INTAKE_ROUTE_ITEMS = [
  {
    key: 'hermes',
    label: '爱马仕战略发现',
    to: '/ai-hotboard/intake/hermes-strategy',
  },
  {
    key: 'xiaoj',
    label: '小J 执行发现',
    to: '/ai-hotboard/intake/xiaoj-execution',
  },
] as const

const STRATEGY_ROUTE_ITEMS = [
  { key: 'm2-a', label: 'M2 A线 | 抓数稳定化', to: '/ai-hotboard/strategy/a' },
  { key: 'm2-b', label: 'M2 B线 | 财务报表自动化', to: '/ai-hotboard/strategy/b' },
  { key: 'm2-c', label: 'M2 C线 | AI短视频→投流ROI', to: '/ai-hotboard/strategy/c' },
  { key: 'm2-d', label: 'M2 D线 | 自动化有效率', to: '/ai-hotboard/strategy/d' },
  { key: 'm2-e', label: 'M2 E线 | 全员Agent协作', to: '/ai-hotboard/strategy/e' },
] as const

export const STRATEGY_LINES = STRATEGY_ROUTE_ITEMS.map((item) => item.label)

export const STRATEGY_ITERATION_ITEMS = [
  'v1 产品化交接（CSO 验收中）',
  'adversarial-v3 45 轮迭代已归档',
  '两周稳定运行后评估黑板架构收编',
] as const

const PRIMARY_NAV_ITEMS = [
  { key: 'view-all', label: '全部 AI 动态', to: '/ai-hotboard' },
  { key: 'view-low-follower', label: '热议帖 (基于互动比 · follower 数据待接入)', to: '/ai-hotboard/view/low-follower' },
  { key: 'view-bookmarks', label: '收藏', to: '/ai-hotboard/view/bookmarks' },
] as const

const SYSTEM_NAV_ITEMS = [
  { key: 'system', label: '系统', to: '/ai-hotboard/system' },
  { key: 'user', label: '用户', to: '/ai-hotboard/user' },
  { key: 'source-health', label: '信源健康', to: '/ai-hotboard/sources/health' },
  { key: 'logout', label: '退出', to: '/ai-hotboard/logout' },
] as const

const MEMBER_SOURCE_LABELS: Record<string, string> = {
  [DATA_SOURCE_LABEL]: 'AI 热点看板信号池',
  x_signal_sync_latest: 'X 实时同步',
  'x_signal_sync_latest.json': 'X 实时同步',
  'hotboard-wechat.sqlite': '公众号手动池',
  'hotboard-zara.sqlite': 'Zara YouTube 精选池',
  [STRATEGY_GLOSSARY_SOURCE_LABEL]: 'M2 业务主线表',
}

export function canAccessOwnerHotboardPanels(authUser: Pick<AuthUser, 'role'> | null | undefined) {
  return authUser?.role === 'owner'
}

export function getVisibleSystemNavItems(authUser: Pick<AuthUser, 'role'> | null | undefined) {
  return canAccessOwnerHotboardPanels(authUser) ? SYSTEM_NAV_ITEMS : []
}

export function resolveVisibleSourceLabel(
  rawLabel: string,
  authUser: Pick<AuthUser, 'role'> | null | undefined,
) {
  if (canAccessOwnerHotboardPanels(authUser)) return rawLabel

  const normalized = rawLabel.trim()
  if (MEMBER_SOURCE_LABELS[normalized]) return MEMBER_SOURCE_LABELS[normalized]
  if (normalized.includes('wechat')) return '公众号手动池'
  if (normalized.includes('zara')) return 'Zara YouTube 精选池'
  if (normalized.includes('x_signal') || normalized.includes('x-signal')) return 'X 实时同步'
  if (normalized.includes('business-glossary')) return 'M2 业务主线表'
  if (/\.json$|\.sqlite$|~\/|^\/Users\//.test(normalized)) return 'AI 热点看板信号池'
  return normalized || 'AI 热点看板信号池'
}

export const SIDEBAR_NAV_SEQUENCE = [
  ...PRIMARY_NAV_ITEMS.map((item) => item.label),
  '信源',
  '信源提报',
  '策略线路',
  '策略迭代',
  ...SYSTEM_NAV_ITEMS.map((item) => item.label),
] as const

const CATEGORY_WEIGHT_MAP: Record<string, number> = {
  同行动作: 40,
  AI基础设施: 30,
  工具赛道: 20,
  纯新闻: 10,
}

const TAG_SIGNAL_BUCKET_MAP: Record<string, keyof typeof CATEGORY_WEIGHT_MAP> = {
  Agent: '同行动作',
  多Agent架构: '同行动作',
  skills: '同行动作',
  对抗式监督: '同行动作',
  Anthropic: 'AI基础设施',
  模型发布: 'AI基础设施',
  编码: '工具赛道',
  工具: '工具赛道',
  API: '工具赛道',
  视频生成: '工具赛道',
  开源: '纯新闻',
  大佬观点: '纯新闻',
}

const ACTION_PREFIXES = ['触发 skill', '派 agent', '更新战略'] as const

const EDITORIAL_DISPLAY_STYLE = {
  fontFamily: '"EB Garamond", "Times New Roman", Georgia, serif',
} satisfies CSSProperties

const EDITORIAL_MONO_STYLE = {
  fontFamily: '"JetBrains Mono", "SFMono-Regular", ui-monospace, monospace',
} satisfies CSSProperties

const HOTBOARD_BACKGROUND_STYLE = {
  backgroundImage:
    'radial-gradient(circle at top left, rgba(56, 189, 248, 0.16), transparent 24%), radial-gradient(circle at top right, rgba(251, 191, 36, 0.12), transparent 22%), linear-gradient(180deg, rgba(2, 6, 23, 1) 0%, rgba(3, 7, 18, 1) 36%, rgba(2, 6, 23, 1) 100%)',
} satisfies CSSProperties

const HOTBOARD_SIDEBAR_STYLE = {
  backgroundImage:
    'radial-gradient(circle at top, rgba(103, 232, 249, 0.11), transparent 28%), linear-gradient(180deg, rgba(2, 6, 23, 0.97) 0%, rgba(2, 6, 23, 0.93) 100%)',
} satisfies CSSProperties

const HOTBOARD_PANEL_STYLE = {
  backgroundImage:
    'radial-gradient(circle at top left, rgba(103, 232, 249, 0.10), transparent 34%), radial-gradient(circle at bottom right, rgba(251, 191, 36, 0.06), transparent 28%), linear-gradient(180deg, rgba(15, 23, 42, 0.92) 0%, rgba(2, 6, 23, 0.9) 100%)',
} satisfies CSSProperties

const HOTBOARD_CARD_STYLE = {
  backgroundImage:
    'radial-gradient(circle at top left, rgba(103, 232, 249, 0.08), transparent 32%), radial-gradient(circle at bottom right, rgba(251, 191, 36, 0.05), transparent 26%), linear-gradient(180deg, rgba(15, 23, 42, 0.9) 0%, rgba(2, 6, 23, 0.86) 100%)',
} satisfies CSSProperties

const HOTBOARD_PANEL_CLASS =
  'relative overflow-hidden border border-white/10 shadow-[0_24px_72px_rgba(2,6,23,0.52),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl'

const HOTBOARD_CARD_CLASS =
  'group relative overflow-hidden rounded-[28px] border border-white/10 shadow-[0_20px_56px_rgba(2,6,23,0.46),inset_0_1px_0_rgba(255,255,255,0.04)] transition-all duration-300 hover:-translate-y-0.5 hover:border-cyan-300/28 hover:shadow-[0_32px_72px_rgba(2,6,23,0.58),0_0_0_1px_rgba(103,232,249,0.10)]'

const HOTBOARD_SECTION_CLASS = `${HOTBOARD_CARD_CLASS} px-5 py-5`
const HOTBOARD_COMPACT_PANEL_CLASS = `${HOTBOARD_CARD_CLASS} px-4 py-4`

const HOTBOARD_FIELD_CLASS =
  'w-full rounded-[18px] border border-white/12 bg-slate-950/75 px-4 py-3 text-sm text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] outline-none transition-all placeholder:text-slate-500 focus:border-cyan-300/65 focus:bg-slate-950/90 focus:shadow-[0_0_0_1px_rgba(103,232,249,0.18)]'

const HOTBOARD_PRIMARY_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-[18px] border border-amber-300/35 bg-amber-300/16 px-4 py-2.5 text-sm font-medium text-amber-50 shadow-[0_18px_40px_rgba(120,53,15,0.2)] transition-all duration-200 hover:-translate-y-px hover:border-amber-200/60 hover:bg-amber-300/22 disabled:cursor-not-allowed disabled:opacity-60'

const HOTBOARD_SECONDARY_BUTTON_CLASS =
  'rounded-[14px] border border-white/12 bg-slate-950/55 px-3 py-1.5 text-xs text-slate-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-all hover:border-cyan-300/35 hover:text-white disabled:cursor-not-allowed disabled:opacity-50'

export const SIGNAL_BADGE_CLASS =
  'inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-[#2a2f3e] text-[12px] font-semibold leading-none text-white shadow-[0_8px_18px_rgba(15,23,42,0.38)]'

export const RECOMMEND_BANNER_CLASS =
  'rounded-xl border border-emerald-400/15 bg-emerald-950/70 px-3 py-2 text-sm leading-6 text-emerald-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]'

function computeSignalScore(event: MockEvent) {
  const tagBuckets = event.tags.map((tag) => TAG_SIGNAL_BUCKET_MAP[tag] ?? '纯新闻')
  const tagWeightTotal = tagBuckets.reduce((score, bucket) => score + CATEGORY_WEIGHT_MAP[bucket], 0)
  const tagWeightAverage = Math.round(tagWeightTotal / Math.max(tagBuckets.length, 1))
  const categoryWeight = CATEGORY_WEIGHT_MAP[event.signal_category] ?? 10

  const engagementScore = Math.round(
    event.engagement.likes * 0.16 + event.engagement.bookmarks * 0.32 - event.engagement.dislikes * 0.48,
  )
  const sourceResonanceScore = Math.min(event.aggregated_sources_count * 2, 12)

  const rawScore =
    58 +
    Math.round(tagWeightAverage / 3.2) +
    Math.round(categoryWeight / 4.5) +
    engagementScore +
    sourceResonanceScore

  return Math.max(60, Math.min(99, rawScore))
}

function normalizeActionLine(action: string) {
  const normalized = action.trim()
  if (ACTION_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return `→ 建议动作：${normalized}`
  }
  return `→ 建议动作：更新战略：${normalized}`
}

function normalizeRecommendReason(reason: string) {
  const normalized = reason.trim() || '待补充'
  if (normalized.startsWith('推荐理由：')) {
    return normalized
  }
  return `推荐理由：${normalized}`
}

function buildCondensedSourceLabel(event: MockEvent) {
  return `${event.source_type} · ${event.source_name} · ${event.source_channel}`
}

function buildAggregatedSourcesLabel(event: MockEvent) {
  if (event.aggregated_sources_count <= 0) return null
  return `另有 ${event.aggregated_sources_count} 个源也报道了此事件`
}

function formatGeneratedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function formatRelativeAge(value?: string | null) {
  if (!value) return '未知时间'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  const diffMs = Math.max(0, Date.now() - timestamp)
  const hour = 60 * 60 * 1000
  const day = 24 * hour
  if (diffMs < hour) return `${Math.max(1, Math.round(diffMs / (60 * 1000)))} 分钟前`
  if (diffMs < day) return `${Math.round(diffMs / hour)} 小时前`
  return `${Math.round(diffMs / day)} 天前`
}

function getEmptyStateCopy(meta: FeedMeta) {
  if (meta.empty_reason === 'source_failure') {
    return {
      title: '信源故障 · 暂无可用数据',
      description: '当前信源读取失败且没有可展示的 last-good 数据。请稍后刷新，或检查信源健康。',
    }
  }

  if (meta.empty_reason === 'permission_denied') {
    return {
      title: '暂无权限查看信号',
      description: '当前账号无权读取该信源。请联系 JC 申请 owner 权限或切换账号。',
    }
  }

  return {
    title: '暂无信号 · 本期为空',
    description: '信源成功同步，但当前筛选条件下没有可展示的新信号。',
  }
}

function formatEntryTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function getTagTone(tag: string) {
  if (tag === 'Agent' || tag === '多Agent架构' || tag === 'skills' || tag === '对抗式监督') {
    return 'border-cyan-300/25 bg-cyan-300/10 text-cyan-100'
  }

  if (tag === '模型发布' || tag === 'Anthropic') {
    return 'border-emerald-300/25 bg-emerald-300/10 text-emerald-100'
  }

  if (tag === '工具' || tag === 'API' || tag === '视频生成' || tag === '编码') {
    return 'border-amber-300/25 bg-amber-300/10 text-amber-100'
  }

  return 'border-slate-400/25 bg-slate-400/10 text-slate-200'
}

function resolveFeedModeByPage(page: AiHotboardPage): FeedMode {
  if (page === 'view-all') return 'all'
  if (page === 'view-low-follower') return 'low-follower'
  if (page === 'view-bookmarks') return 'bookmarks'
  return 'featured'
}

export function resolveFeedSourceForPage(page: AiHotboardPage, source: string) {
  if (page === 'view-low-follower') return 'low-follower'
  return source
}

function isFeedPage(page: AiHotboardPage) {
  return (
    page === 'featured' ||
    page === 'view-all' ||
    page === 'view-low-follower' ||
    page === 'view-bookmarks' ||
    page.startsWith('source-')
  )
}

export function shouldShowExpandedFeedChrome(page: AiHotboardPage) {
  return getHotboardRouteChrome(page) === 'expanded'
}

function isPlaceholderSourcePage(page: AiHotboardPage): page is Extract<SourcePageKey, 'source-jc-human-talks'> {
  return page === 'source-jc-human-talks'
}

function getFeedHeading(page: AiHotboardPage) {
  if (page === 'featured') {
    return {
      title: 'AI 热点看板',
      subtitle: '全量时间线 · 便于回看今日所有信号',
    }
  }

  if (page === 'view-all') {
    return {
      title: '全部 AI 动态',
      subtitle: '全量时间线 · 便于回看今日所有信号',
    }
  }

  if (page === 'view-low-follower') {
    return {
      title: '热议帖 (基于互动比 · follower 数据待接入)',
      subtitle: '互动比偏高的代理热点 · follower 数据待接入',
    }
  }

  if (page === 'view-bookmarks') {
    return {
      title: '收藏',
      subtitle: '当前账号已收藏的热点记录',
    }
  }

  if (page === 'source-x-bookmarks') {
    return {
      title: '信源 · X bookmarks',
      subtitle: '信源视角 · X bookmarks 同步',
    }
  }

  if (page === 'source-x-likes') {
    return {
      title: '信源 · X likes',
      subtitle: '信源视角 · X likes 同步',
    }
  }

  if (page === 'source-x-following') {
    return {
      title: '信源 · X following',
      subtitle: '信源视角 · X following 同步',
    }
  }

  if (page === 'source-x-for_you') {
    return {
      title: '信源 · X for_you',
      subtitle: '信源视角 · X for_you 同步',
    }
  }

  if (page === 'source-wechat') {
    return {
      title: '信源 · 公众号',
      subtitle: '手工扔 URL 即时抓取 · owner 可直接投递微信文章',
    }
  }

  if (page === 'source-zara-youtube') {
    return {
      title: 'Zara YouTube 精选',
      subtitle: 'Zara Zhang AI 学习库 · YouTube curated library',
    }
  }

  return {
    title: 'AI 热点看板',
    subtitle: '全量时间线 · 便于回看今日所有信号',
  }
}

export function buildFeedStats(
  events: TimelineEvent[],
  voteAggregateByEvent: VoteAggregateByEvent = {},
) {
  const totalLikes = events.reduce((sum, event) => {
    const aggregate = voteAggregateByEvent[event.id]
    return sum + (aggregate ? aggregate.like_count : event.engagement.likes)
  }, 0)
  const totalBookmarks = events.reduce((sum, event) => {
    const aggregate = voteAggregateByEvent[event.id]
    return sum + (aggregate ? aggregate.bookmark_count : event.engagement.bookmarks)
  }, 0)
  const averageSignalScore =
    events.length > 0
      ? Math.round(events.reduce((sum, event) => sum + event.signalScore, 0) / events.length)
      : 0

  return {
    totalEvents: events.length,
    totalLikes,
    totalBookmarks,
    averageSignalScore,
  }
}

type HotboardStatCardTone = 'cyan' | 'amber' | 'emerald'

function HotboardStatCard({
  label,
  value,
  icon,
  helper,
  trendLabel,
  tone,
}: {
  label: string
  value: number
  icon: typeof ActivitySparkIcon
  helper: string
  trendLabel: string
  tone: HotboardStatCardTone
}) {
  const toneStyles = {
    cyan: {
      chip: 'border-cyan-300/25 bg-cyan-300/12 text-cyan-100 shadow-[0_16px_32px_rgba(8,145,178,0.18)]',
      badge: 'border-cyan-300/20 bg-cyan-300/10 text-cyan-100',
    },
    amber: {
      chip: 'border-amber-300/25 bg-amber-300/12 text-amber-100 shadow-[0_16px_32px_rgba(120,53,15,0.18)]',
      badge: 'border-amber-300/20 bg-amber-300/10 text-amber-100',
    },
    emerald: {
      chip: 'border-emerald-300/25 bg-emerald-300/12 text-emerald-100 shadow-[0_16px_32px_rgba(4,120,87,0.18)]',
      badge: 'border-emerald-300/20 bg-emerald-300/10 text-emerald-100',
    },
  }[tone]

  return (
    <article className={cn(HOTBOARD_CARD_CLASS, 'min-h-[152px] px-4 py-4 sm:px-5')} style={HOTBOARD_CARD_STYLE}>
      <div className="absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent opacity-60" />
      <div className="flex h-full items-start justify-between gap-4">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'inline-flex h-11 w-11 items-center justify-center rounded-[18px] border animate-pulse [animation-duration:6s]',
                toneStyles.chip,
              )}
            >
              <HugeiconsIcon icon={icon} size={22} strokeWidth={1.6} />
            </span>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] tracking-[0.2em]',
                toneStyles.badge,
              )}
              style={EDITORIAL_MONO_STYLE}
            >
              <HugeiconsIcon icon={ArrowUp01Icon} size={12} strokeWidth={1.8} />
              {trendLabel}
            </span>
          </div>

          <div>
            <div className="text-[11px] tracking-[0.26em] text-slate-500" style={EDITORIAL_MONO_STYLE}>
              {label}
            </div>
            <div className="mt-3 text-[2.35rem] leading-none text-white sm:text-[2.8rem]" style={EDITORIAL_DISPLAY_STYLE}>
              {value.toLocaleString('en-US')}
            </div>
          </div>
        </div>

        <p className="hidden max-w-[9.5rem] text-right text-[11px] leading-5 text-slate-500 lg:block">
          {helper}
        </p>
      </div>
    </article>
  )
}

function FriendlyEmptyState({
  icon,
  title,
  description,
  ctaLabel,
  ctaTo,
}: {
  icon: typeof AiSearchIcon
  title: string
  description: string
  ctaLabel: string
  ctaTo: string
}) {
  return (
    <section className={cn(HOTBOARD_CARD_CLASS, 'px-6 py-8 text-center sm:px-8')} style={HOTBOARD_CARD_STYLE}>
      <div className="mx-auto flex max-w-xl flex-col items-center">
        <span className="inline-flex h-14 w-14 items-center justify-center rounded-[20px] border border-cyan-300/20 bg-cyan-300/10 text-cyan-100 shadow-[0_18px_40px_rgba(8,145,178,0.18)]">
          <HugeiconsIcon icon={icon} size={26} strokeWidth={1.6} />
        </span>
        <div className="mt-5 text-[11px] tracking-[0.28em] text-slate-500" style={EDITORIAL_MONO_STYLE}>
          QUEUE EMPTY
        </div>
        <h3 className="mt-3 text-[2rem] leading-none text-white sm:text-[2.3rem]" style={EDITORIAL_DISPLAY_STYLE}>
          {title}
        </h3>
        <p className="mt-3 text-sm leading-7 text-slate-300 sm:text-[15px]">{description}</p>
        <Link to={ctaTo} className={cn(HOTBOARD_PRIMARY_BUTTON_CLASS, 'mt-6 px-5')}>
          {ctaLabel}
          <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={1.8} />
        </Link>
      </div>
    </section>
  )
}

export function feedMatchesMode(
  event: TimelineEvent,
  mode: FeedMode,
  voteAggregateByEvent: VoteAggregateByEvent,
) {
  if (mode === 'all') return true

  if (mode === 'low-follower') {
    return true
  }

  if (mode === 'bookmarks') {
    return voteAggregateByEvent[event.id]?.my_vote.includes('bookmark') ?? false
  }

  return event.signalScore >= 84
}

function LinkNavItems({
  items,
  highlightedKey,
  exactHighlights = false,
}: {
  items: readonly NavItem[]
  highlightedKey?: string
  exactHighlights?: boolean
}) {
  return (
    <ul className="space-y-1.5">
      {items.map((item) => {
        const highlighted = item.key === highlightedKey

        return (
          <li key={item.key} className="list-none" data-nav-item={item.label}>
            <Link
              to={item.to}
              activeOptions={exactHighlights ? { exact: true } : undefined}
              className="block rounded-[18px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/50"
            >
              <div
                className={cn(
                  'rounded-[18px] border px-3 py-2 text-sm transition-all duration-200',
                  highlighted
                    ? 'border-cyan-300/55 bg-cyan-300/16 font-medium text-cyan-50 shadow-[0_18px_36px_rgba(8,145,178,0.18),inset_0_1px_0_rgba(255,255,255,0.06)]'
                    : 'border-white/10 bg-slate-950/50 text-slate-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] hover:-translate-y-px hover:border-slate-400/40 hover:bg-slate-900/78 hover:text-slate-50',
                )}
              >
                {item.label}
              </div>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

function SidebarSectionLinkGroup({
  title,
  items,
  highlightedKey,
  testId,
}: {
  title: string
  items: readonly NavItem[]
  highlightedKey?: string
  testId?: string
}) {
  return (
    <section className="space-y-1.5" aria-label={`${title}导航`} data-testid={testId}>
      <ul className="space-y-1.5">
        <li className="list-none" data-nav-item={title}>
          <div className="rounded-[18px] border border-white/10 bg-slate-950/55 px-3 py-2 text-sm font-medium text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            {title}
          </div>
        </li>
      </ul>
      <div className="pl-2">
        <LinkNavItems items={items} highlightedKey={highlightedKey} />
      </div>
    </section>
  )
}

function SourceRouteItems({
  highlightedPage,
}: {
  highlightedPage: AiHotboardPage
}) {
  const highlightedKey =
    highlightedPage === 'source-x-bookmarks'
      ? 'x-bookmarks'
      : highlightedPage === 'source-x-likes'
      ? 'x-likes'
      : highlightedPage === 'source-x-following'
      ? 'x-following'
      : highlightedPage === 'source-x-for_you'
      ? 'x-for_you'
      : highlightedPage === 'source-wechat'
      ? 'wechat'
      : highlightedPage === 'source-zara-youtube'
      ? 'zara-youtube'
      : highlightedPage === 'source-jc-human-talks'
      ? 'jc-human-talks'
      : undefined

  return (
    <ul className="space-y-1.5">
      <li className="list-none" data-nav-item="信源">
        <div className="rounded-[18px] border border-white/10 bg-slate-950/55 px-3 py-2 text-sm font-medium text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
          信源
        </div>
      </li>
      <li className="list-none">
        <div className="pl-2 space-y-1.5">
          <LinkNavItems items={X_SOURCE_ROUTE_ITEMS} highlightedKey={highlightedKey} />
          <LinkNavItems
            items={[{ key: 'wechat', label: '公众号', to: '/ai-hotboard/source/wechat' }]}
            highlightedKey={highlightedKey}
          />
          <LinkNavItems items={ZARA_SOURCE_ROUTE_ITEMS} highlightedKey={highlightedKey} />
          <LinkNavItems items={SOURCE_PLACEHOLDER_ROUTE_ITEMS} highlightedKey={highlightedKey} />
        </div>
      </li>
    </ul>
  )
}

function feedPageHighlightedNavKey(page: AiHotboardPage) {
  if (page === 'featured' || page === 'view-all') return 'view-all'
  if (page === 'view-low-follower') return 'view-low-follower'
  if (page === 'view-bookmarks') return 'view-bookmarks'
  return undefined
}

function systemPageHighlightedNavKey(page: AiHotboardPage) {
  if (page === 'system') return 'system'
  if (page === 'user') return 'user'
  if (page === 'logout') return 'logout'
  return undefined
}

function intakeHighlightedKey(page: AiHotboardPage) {
  if (page === 'intake-hermes') return 'hermes'
  if (page === 'intake-xiaoj') return 'xiaoj'
  return undefined
}

function strategyHighlightedKey(strategyLine: string) {
  const key = strategyLine.trim().toLowerCase()
  const matched = STRATEGY_ROUTE_ITEMS.find((item) => item.key === key)
  return matched?.key
}

export function resolveStrategyLineKey(input?: string) {
  const value = (input || 'm2-a').trim().toLowerCase()
  if (value === 'a' || value === 'm2-a') return 'm2-a'
  if (value === 'b' || value === 'm2-b') return 'm2-b'
  if (value === 'c' || value === 'm2-c') return 'm2-c'
  if (value === 'd' || value === 'm2-d') return 'm2-d'
  if (value === 'e' || value === 'm2-e') return 'm2-e'
  return 'm2-a'
}

function V2PlaceholderPanel({
  title,
  expectedWeek,
  owner,
  dataSource,
}: {
  title: string
  expectedWeek: string
  owner: string
  dataSource: string
}) {
  return (
    <section className={HOTBOARD_SECTION_CLASS} style={HOTBOARD_CARD_STYLE}>
      <div className="text-[11px] tracking-[0.26em] text-cyan-300/80" style={EDITORIAL_MONO_STYLE}>PLACEHOLDER</div>
      <h2 className="mt-2 text-[2.2rem] leading-none text-slate-100" style={EDITORIAL_DISPLAY_STYLE}>{title}</h2>
      <div className="mt-3 rounded-2xl border border-cyan-400/35 bg-cyan-400/10 px-4 py-3 text-lg font-medium text-cyan-100">
        当前由 {owner} 维护,数据接入窗口：{expectedWeek}
      </div>
      <div className="mt-4 space-y-2 text-sm text-slate-300">
        <div>数据来源：{dataSource}</div>
        <div>负责人：{owner}</div>
      </div>
    </section>
  )
}

export function JcHumanTalksComingSoonCard() {
  return (
    <section className={HOTBOARD_SECTION_CLASS} style={HOTBOARD_CARD_STYLE}>
      <div className="text-[11px] tracking-[0.26em] text-cyan-300/80" style={EDITORIAL_MONO_STYLE}>COMING SOON</div>
      <h2 className="mt-2 text-[2.2rem] leading-none text-slate-100" style={EDITORIAL_DISPLAY_STYLE}>JC 的人类对谈</h2>
      <p className="mt-3 text-sm leading-6 text-slate-300">JC 与同行/朋友的高密度对谈精选片段,目前由 JC 手工从飞书妙记挑选。</p>
      <p className="mt-2 text-sm leading-6 text-slate-400/80">由 JC 手工挑选 · 暂无新内容</p>
    </section>
  )
}

export function FeedErrorBanners({ authCheckError, feedFetchError }: { authCheckError: string | null; feedFetchError: string | null }) {
  if (!authCheckError && !feedFetchError) return null

  return (
    <div className="space-y-3">
      {authCheckError ? (
        <div className="rounded-lg border border-red-300/30 bg-red-400/8 px-4 py-3 text-sm text-red-200/90">
          身份核验失败, 请刷新页面或联系管理员 (飞书私聊 JC)
        </div>
      ) : null}
      {feedFetchError ? (
        <div className="rounded-lg border border-red-300/30 bg-red-400/8 px-4 py-3 text-sm text-red-200/90">
          数据加载失败, 请刷新页面或联系管理员 (飞书私聊 JC)
        </div>
      ) : null}
    </div>
  )
}

export function FeedMetaBanners({ meta }: { meta: FeedMeta }) {
  const hasPartialFailures = meta.partial_failures.length > 0
  const isSourceFailure = meta.empty_reason === 'source_failure' || Boolean(meta.source_failure_reason)

  if (!hasPartialFailures && !meta.stale) return null

  return (
    <div className="space-y-3">
      {hasPartialFailures ? (
        <div className="rounded-lg border border-amber-300/30 bg-amber-400/8 px-4 py-3 text-sm text-amber-200/90">
          数据源同步异常: {meta.partial_failures.join(', ')}
        </div>
      ) : null}
      {meta.stale ? (
        <div className="rounded-lg border border-slate-300/20 bg-slate-700/30 px-4 py-3 text-sm text-slate-300/80">
          {isSourceFailure
            ? `数据上次成功更新 ${formatRelativeAge(meta.last_success_at)} (信源故障)`
            : '数据距上次同步 24h+, 可能过时'}
        </div>
      ) : null}
    </div>
  )
}

export function getHotboardStatusChipLabel({
  loading,
  hasError,
  visibleCount,
  totalCount,
}: {
  loading: boolean
  hasError: boolean
  visibleCount: number
  totalCount: number
}) {
  if (loading) return '同步中...'
  const countLabel = `${visibleCount}/${totalCount} 显示`
  return hasError ? `⚠ ${countLabel}` : countLabel
}

export function HotboardStatusChip({
  loading,
  hasError,
  visibleCount,
  totalCount,
}: {
  loading: boolean
  hasError: boolean
  visibleCount: number
  totalCount: number
}) {
  return (
    <div
      data-testid="hotboard-status-chip"
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold tracking-[0.12em]',
        hasError
          ? 'border-amber-300/45 bg-amber-300/10 text-amber-100'
          : 'border-cyan-300/30 bg-cyan-300/10 text-cyan-100',
      )}
      style={EDITORIAL_MONO_STYLE}
    >
      {loading ? <span className="inline-block animate-spin">○</span> : null}
      {getHotboardStatusChipLabel({ loading, hasError, visibleCount, totalCount })}
    </div>
  )
}

export function SeenEventsToggle({
  showSeenEvents,
  onToggle,
}: {
  showSeenEvents: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={showSeenEvents}
      className={cn(HOTBOARD_SECONDARY_BUTTON_CLASS, 'border-cyan-300/20 text-slate-100 hover:border-cyan-200/45')}
    >
      {showSeenEvents ? '[x]' : '[ ]'} 显示已读
    </button>
  )
}

function StrategyPanel({
  strategyLine,
  item,
  loading,
  error,
  authUser,
}: {
  strategyLine: string
  item: StrategyStatusItem | null
  loading: boolean
  error: string | null
  authUser: AuthUser | null
}) {
  const label = STRATEGY_ROUTE_ITEMS.find((route) => route.key === strategyLine)?.label ?? strategyLine

  return (
    <section className={HOTBOARD_SECTION_CLASS} style={HOTBOARD_CARD_STYLE}>
      <div className="text-[11px] tracking-[0.26em] text-cyan-300/80" style={EDITORIAL_MONO_STYLE}>M2 STRATEGY</div>
      <h2 className="mt-2 text-[2.2rem] leading-none text-slate-100" style={EDITORIAL_DISPLAY_STYLE}>{label}</h2>

      {loading ? (
        <div className="mt-4 rounded-xl border border-slate-700/70 bg-slate-950/45 px-4 py-3 text-sm text-slate-300">正在读取主线状态...</div>
      ) : error ? (
        <div className="mt-4 rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">读取失败：{error}</div>
      ) : item ? (
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div className="rounded-xl border border-slate-700/70 bg-slate-950/45 px-4 py-3">
            <div className="text-xs tracking-[0.2em] text-slate-400">主线</div>
            <div className="mt-1 text-lg font-medium text-slate-100">{item.code}</div>
            <div className="mt-1 text-slate-300">{item.name}</div>
          </div>
          <div className="rounded-xl border border-slate-700/70 bg-slate-950/45 px-4 py-3">
            <div className="text-xs tracking-[0.2em] text-slate-400">负责人</div>
            <div className="mt-2 text-slate-100">{item.owner}</div>
          </div>
          <div className="rounded-xl border border-slate-700/70 bg-slate-950/45 px-4 py-3">
            <div className="text-xs tracking-[0.2em] text-slate-400">优先级</div>
            <div className="mt-2 text-slate-100">{item.priority}</div>
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-slate-700/70 bg-slate-950/45 px-4 py-3 text-sm text-slate-300">当前主线暂无状态数据。</div>
      )}

      <div className="mt-4 text-xs text-slate-400">状态来源：{resolveVisibleSourceLabel(STRATEGY_GLOSSARY_SOURCE_LABEL, authUser)}</div>
    </section>
  )
}

export function IntakePanel({
  authorAgent,
  title,
  authUser,
  items,
  selectedItemId,
  onSelectItem,
  draft,
  onDraftChange,
  onSubmit,
  submitting,
  requestError,
  listLoading,
  listError,
}: {
  authorAgent: IntakeAgentKey
  title: string
  authUser: AuthUser | null
  items: IntakeItem[]
  selectedItemId: string | null
  onSelectItem: (id: string) => void
  draft: { title: string; body: string; tagsText: string }
  onDraftChange: (next: { title?: string; body?: string; tagsText?: string }) => void
  onSubmit: () => void
  submitting: boolean
  requestError: string | null
  listLoading: boolean
  listError: string | null
}) {
  const canWrite = authUser?.role === 'owner'

  const selectedItem =
    items.find((item) => item.id === selectedItemId) ||
    items[0] ||
    null

  return (
    <section className={HOTBOARD_SECTION_CLASS} style={HOTBOARD_CARD_STYLE}>
      <div className="text-[11px] tracking-[0.26em] text-cyan-300/80" style={EDITORIAL_MONO_STYLE}>INTAKE</div>
      <h2 className="mt-2 text-[2.2rem] leading-none text-slate-100" style={EDITORIAL_DISPLAY_STYLE}>{title}</h2>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="space-y-3">
          <div className="rounded-xl border border-slate-700/70 bg-slate-950/45 px-4 py-3 text-sm text-slate-300">当前流：{authorAgent === 'hermes' ? '爱马仕战略发现' : '小J 执行发现'}</div>

          {listLoading ? (
            <div className="rounded-xl border border-slate-700/70 bg-slate-950/45 px-4 py-3 text-sm text-slate-300">正在加载提报列表...</div>
          ) : listError ? (
            <div className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">读取失败：{listError}</div>
          ) : items.length === 0 ? (
            <div className="rounded-xl border border-slate-700/70 bg-slate-950/45 px-4 py-3 text-sm text-slate-300">暂无提报记录。</div>
          ) : (
            <ul className="space-y-2">
              {items.map((item) => {
                const selected = item.id === selectedItem?.id
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => onSelectItem(item.id)}
                      className={cn(
                        'w-full rounded-[18px] border px-3 py-2 text-left transition-all duration-200',
                        selected
                          ? 'border-cyan-300/50 bg-cyan-300/14 text-cyan-100 shadow-[0_18px_36px_rgba(8,145,178,0.16),inset_0_1px_0_rgba(255,255,255,0.04)]'
                          : 'border-white/10 bg-slate-950/55 text-slate-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] hover:-translate-y-px hover:border-slate-400/40 hover:text-slate-100',
                      )}
                    >
                      <div className="text-sm font-medium">{item.title}</div>
                      <div className="mt-1 text-xs text-slate-400">{formatEntryTime(item.created_at)} · {item.submitted_by_name}</div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="space-y-3">
          {selectedItem ? (
            <article className="rounded-[22px] border border-white/10 bg-slate-950/50 px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <h3 className="text-[1.7rem] leading-none text-slate-100" style={EDITORIAL_DISPLAY_STYLE}>{selectedItem.title}</h3>
              <div className="mt-1 text-xs text-slate-400">{formatEntryTime(selectedItem.created_at)} · {selectedItem.submitted_by_name}</div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-200">{selectedItem.body}</p>
              {selectedItem.tags.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {selectedItem.tags.map((tag) => (
                    <span key={`${selectedItem.id}-${tag}`} className="rounded-full border border-slate-600/60 bg-slate-900/80 px-2 py-0.5 text-xs text-slate-300">{tag}</span>
                  ))}
                </div>
              ) : null}
            </article>
          ) : null}

          <div className="rounded-[22px] border border-white/10 bg-slate-950/50 px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            {!canWrite ? (
              <div className="rounded-md border border-slate-700/70 bg-slate-900/70 px-3 py-3 text-sm leading-6 text-slate-300">
                <div className="font-medium text-slate-100">只读列表</div>
                <p className="mt-1">当前账号为员工只读身份，可查看提报列表，不能新增或编辑提报。</p>
                <a
                  href="https://applink.feishu.cn/client/chat/open?openId=ou_01e621b00ca6ba95e9a1e10bb444c9ae"
                  className="mt-2 inline-flex text-cyan-200 underline decoration-cyan-300/40 underline-offset-4 hover:text-cyan-100"
                >
                  联系 JC 申请 owner 权限
                </a>
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                <div className="text-sm font-medium text-slate-100">新增提报</div>
                <input
                  type="text"
                  value={draft.title}
                  onChange={(event) => onDraftChange({ title: event.target.value })}
                  placeholder="标题"
                  className={HOTBOARD_FIELD_CLASS}
                />
                <textarea
                  value={draft.body}
                  onChange={(event) => onDraftChange({ body: event.target.value })}
                  placeholder="正文"
                  rows={5}
                  className={cn(HOTBOARD_FIELD_CLASS, 'min-h-[7.5rem] resize-y')}
                />
                <input
                  type="text"
                  value={draft.tagsText}
                  onChange={(event) => onDraftChange({ tagsText: event.target.value })}
                  placeholder="tags，逗号分隔"
                  className={HOTBOARD_FIELD_CLASS}
                />
                {requestError ? (
                  <div className="rounded-md border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-100">{requestError}</div>
                ) : null}
                <button
                  type="button"
                  onClick={onSubmit}
                  disabled={submitting}
                  className={HOTBOARD_PRIMARY_BUTTON_CLASS}
                >
                  {submitting ? '提交中...' : '提交提报'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function IterationPanel() {
  return (
    <section className={HOTBOARD_SECTION_CLASS} style={HOTBOARD_CARD_STYLE} data-testid="strategy-iteration-section">
      <div className="text-[11px] tracking-[0.26em] text-cyan-300/80" style={EDITORIAL_MONO_STYLE}>ITERATION</div>
      <h2 className="mt-2 text-[2.2rem] leading-none text-slate-100" style={EDITORIAL_DISPLAY_STYLE}>策略迭代</h2>
      <ul className="mt-4 space-y-2">
        {STRATEGY_ITERATION_ITEMS.map((item) => (
          <li key={item} className="rounded-[18px] border border-white/10 bg-slate-950/55 px-4 py-3 text-sm text-slate-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            {item}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function WechatIngestPanel({
  authUser,
  draftUrl,
  onDraftUrlChange,
  onSubmit,
  submitting,
  requestError,
}: {
  authUser: AuthUser | null
  draftUrl: string
  onDraftUrlChange: (value: string) => void
  onSubmit: () => void
  submitting: boolean
  requestError: string | null
}) {
  const isOwner = authUser?.role === 'owner'

  function showOwnerOnlyToast(event: { currentTarget: HTMLElement }) {
    if (isOwner) return
    event.currentTarget.querySelector<HTMLElement>('[data-owner-only-toast]')?.removeAttribute('hidden')
  }

  function handleSubmit() {
    if (!isOwner) return
    onSubmit()
  }

  return (
    <section
      className={cn(HOTBOARD_COMPACT_PANEL_CLASS, !isOwner && 'cursor-not-allowed opacity-50')}
      style={HOTBOARD_CARD_STYLE}
      data-testid="wechat-ingest-panel"
      onClick={showOwnerOnlyToast}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-[18px] border border-cyan-300/20 bg-cyan-300/10 text-cyan-100 shadow-[0_16px_30px_rgba(8,145,178,0.18)] animate-pulse [animation-duration:6s]">
              <HugeiconsIcon icon={LinkSquareIcon} size={22} strokeWidth={1.6} />
            </span>
            <div>
              <div className="text-[11px] tracking-[0.28em] text-slate-500" style={EDITORIAL_MONO_STYLE}>OWNER DROP</div>
              <div className="mt-1 text-lg text-slate-100">粘贴微信公众号文章 URL</div>
            </div>
          </div>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-300">
            像给 agent 投递指令一样，把公众号链接扔进来。系统会抓取正文、落库，再回流到热板时间线。
          </p>
        </div>

        <div className="rounded-full border border-white/10 bg-slate-950/55 px-3 py-1 text-[11px] tracking-[0.2em] text-slate-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]" style={EDITORIAL_MONO_STYLE}>
          {'MP > INGEST > SCORE'}
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 xl:flex-row">
        <div className="flex min-w-0 flex-1 items-center gap-3 rounded-[22px] border border-white/10 bg-slate-950/60 px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <span className="rounded-full border border-white/10 bg-slate-900/80 px-2.5 py-1 text-[11px] text-cyan-100" style={EDITORIAL_MONO_STYLE}>
            DROP URL
          </span>
          <input
            type="url"
            value={draftUrl}
            onChange={(event) => {
              if (isOwner) onDraftUrlChange(event.target.value)
            }}
            disabled={!isOwner}
            placeholder={isOwner ? 'https://mp.weixin.qq.com/s/...' : 'owner 限定 · 联系 JC 开权限'}
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500 disabled:cursor-not-allowed"
          />
        </div>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!isOwner || submitting}
          className={cn(HOTBOARD_PRIMARY_BUTTON_CLASS, 'min-w-[8.5rem]')}
        >
          {submitting ? '抓取中...' : '抓取文章'}
          <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={1.8} />
        </button>
      </div>
      {!isOwner ? (
        <div hidden data-owner-only-toast className="mt-2 rounded-md border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs text-amber-100">此功能仅限 owner, 请联系 JC</div>
      ) : null}
      {requestError ? (
        <div className="mt-2 rounded-md border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-100">{requestError}</div>
      ) : null}
    </section>
  )
}

export function ZaraRefreshPanel({
  authUser,
  onRefresh,
  refreshing,
  requestError,
}: {
  authUser: AuthUser | null
  onRefresh: () => void
  refreshing: boolean
  requestError: string | null
}) {
  const isOwner = authUser?.role === 'owner'

  function showOwnerOnlyToast(event: { currentTarget: HTMLElement }) {
    if (isOwner) return
    event.currentTarget.querySelector<HTMLElement>('[data-owner-only-toast]')?.removeAttribute('hidden')
  }

  function handleRefresh() {
    if (!isOwner) return
    onRefresh()
  }

  return (
    <section
      className={cn(HOTBOARD_COMPACT_PANEL_CLASS, !isOwner && 'cursor-not-allowed opacity-50')}
      style={HOTBOARD_CARD_STYLE}
      data-testid="zara-refresh-panel"
      onClick={showOwnerOnlyToast}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-[11px] tracking-[0.28em] text-slate-500" style={EDITORIAL_MONO_STYLE}>CURATED REFRESH</div>
          <div className="mt-2 text-lg text-slate-100">Zara YouTube 精选刷新</div>
          <div className="mt-2 text-sm leading-7 text-slate-300">通过 Playwright 抓取 Zara 学习库里的 YouTube 精选区，并同步到本地 SQLite。</div>
        </div>
        <div className="rounded-full border border-white/10 bg-slate-950/55 px-3 py-1 text-[11px] tracking-[0.2em] text-slate-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]" style={EDITORIAL_MONO_STYLE}>
          {'YT > CURATE > SQLITE'}
        </div>
      </div>
      <div className="mt-3">
        <button
          type="button"
          onClick={handleRefresh}
          disabled={!isOwner || refreshing}
          className={HOTBOARD_PRIMARY_BUTTON_CLASS}
          title={isOwner ? '抓取并刷新 Zara feed' : 'owner 限定 · 联系 JC 手动刷新'}
          aria-label={isOwner ? '抓取并刷新 Zara feed' : 'owner 限定 · 联系 JC 手动刷新'}
        >
          {refreshing ? '刷新中...' : isOwner ? '刷新 Zara 源' : 'owner 限定 · 联系 JC 手动刷新'}
          <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={1.8} />
        </button>
      </div>
      {!isOwner ? (
        <div hidden data-owner-only-toast className="mt-2 rounded-md border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs text-amber-100">此功能仅限 owner, 请联系 JC</div>
      ) : null}
      {requestError ? (
        <div className="mt-2 rounded-md border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-100">{requestError}</div>
      ) : null}
    </section>
  )
}

function ZaraYoutubeTimeline({ items }: { items: ZaraYoutubeSummary[] }) {
  if (items.length === 0) {
    return (
      <FriendlyEmptyState
        icon={AiSearchIcon}
        title="Zara 精选暂时还没到站"
        description="当前源还没有抓到可展示的精选条目。可以先回到主看板看全局热点，或用上面的刷新入口再拉一轮。"
        ctaLabel="返回 AI 热点看板"
        ctaTo="/ai-hotboard"
      />
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {items.map((item) => (
        <article
          key={item.videoId}
          className={cn(HOTBOARD_CARD_CLASS, 'overflow-hidden')}
          style={HOTBOARD_CARD_STYLE}
        >
          <a href={item.url} target="_blank" rel="noreferrer" className="block">
            {item.thumbnailUrl ? (
              <img
                src={item.thumbnailUrl}
                alt={item.title}
                className="aspect-video w-full object-cover"
              />
            ) : (
              <div className="aspect-video w-full bg-slate-800" />
            )}
          </a>
          <div className="space-y-3 px-4 py-4">
            <div>
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="text-[1.7rem] leading-[1.15] text-slate-100 transition-colors hover:text-cyan-200"
                style={EDITORIAL_DISPLAY_STYLE}
              >
                {item.title}
              </a>
              <div className="mt-1 text-sm text-slate-400">
                {item.channel || '未知频道'}
                {item.firstSeenAt ? ` · ${formatEntryTime(item.firstSeenAt)}` : ''}
              </div>
            </div>
            {item.description ? (
              <p className="text-sm leading-6 text-slate-300">{item.description}</p>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              {item.tags.map((tag) => (
                <span key={`${item.videoId}-${tag}`} className={cn('rounded-full border px-2 py-0.5 text-[11px]', getTagTone(tag))}>
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </article>
      ))}
    </div>
  )
}

function BasicPagePanel({
  page,
  onLogout,
  isLoggingOut,
  authUser,
}: {
  page: AiHotboardPage
  onLogout: () => void
  isLoggingOut: boolean
  authUser: AuthUser | null
}) {
  if ((page === 'system' || page === 'user') && !canAccessOwnerHotboardPanels(authUser)) {
    return (
      <section className={HOTBOARD_SECTION_CLASS} style={HOTBOARD_CARD_STYLE}>
        <div className="text-[11px] tracking-[0.26em] text-amber-300/80" style={EDITORIAL_MONO_STYLE}>OWNER ONLY</div>
        <h2 className="mt-2 text-[2.2rem] leading-none text-slate-100" style={EDITORIAL_DISPLAY_STYLE}>需要 owner 权限</h2>
        <p className="mt-3 text-sm leading-6 text-slate-300">当前账号为员工只读身份，后台页面仅对 owner 开放。</p>
        <a
          href="https://applink.feishu.cn/client/chat/open?openId=ou_01e621b00ca6ba95e9a1e10bb444c9ae"
          className="mt-4 inline-flex text-sm text-cyan-200 underline decoration-cyan-300/40 underline-offset-4 hover:text-cyan-100"
        >
          联系 JC 申请 owner 权限
        </a>
      </section>
    )
  }

  if (page === 'system') {
    return (
      <section className={HOTBOARD_SECTION_CLASS} style={HOTBOARD_CARD_STYLE}>
        <div className="text-[11px] tracking-[0.26em] text-cyan-300/80" style={EDITORIAL_MONO_STYLE}>SYSTEM</div>
        <h2 className="mt-2 text-[2.2rem] leading-none text-slate-100" style={EDITORIAL_DISPLAY_STYLE}>系统</h2>
        <p className="mt-3 text-sm leading-6 text-slate-300">系统页已接入，用于后续放置环境配置、任务开关与数据回补入口。</p>
      </section>
    )
  }

  if (page === 'user') {
    return (
      <section className={HOTBOARD_SECTION_CLASS} style={HOTBOARD_CARD_STYLE}>
        <div className="text-[11px] tracking-[0.26em] text-cyan-300/80" style={EDITORIAL_MONO_STYLE}>USER</div>
        <h2 className="mt-2 text-[2.2rem] leading-none text-slate-100" style={EDITORIAL_DISPLAY_STYLE}>用户</h2>
        <p className="mt-3 text-sm leading-6 text-slate-300">用户页已接入，后续可扩展我的收藏统计与个人偏好设置。</p>
      </section>
    )
  }

  return (
    <section className={HOTBOARD_SECTION_CLASS} style={HOTBOARD_CARD_STYLE}>
      <div className="text-[11px] tracking-[0.26em] text-cyan-300/80" style={EDITORIAL_MONO_STYLE}>LOGOUT</div>
      <h2 className="mt-2 text-[2.2rem] leading-none text-slate-100" style={EDITORIAL_DISPLAY_STYLE}>退出</h2>
      <p className="mt-3 text-sm leading-6 text-slate-300">将结束当前登录会话并返回 ai-hotboard 入口。</p>
      <button
        type="button"
        onClick={onLogout}
        disabled={isLoggingOut}
        className={cn(HOTBOARD_SECONDARY_BUTTON_CLASS, 'mt-4 px-3 py-2 text-sm text-slate-100 hover:border-slate-300')}
      >
        {isLoggingOut ? '退出中...' : '确认退出'}
      </button>
    </section>
  )
}

export function FeedTimeline({
  timelineGroups,
  resolveVoteAggregate,
  handleVoteClick,
  seenEventIds = new Set<string>(),
  showSeenEvents = false,
  expandedSeenEventIds = new Set<string>(),
  onExpandSeenEvent,
}: {
  timelineGroups: TimelineGroup[]
  resolveVoteAggregate: (event: TimelineEvent) => VoteAggregateEntry
  handleVoteClick: (eventId: string, voteType: VoteType, baseline?: VoteAggregateEntry) => void
  seenEventIds?: ReadonlySet<string>
  showSeenEvents?: boolean
  expandedSeenEventIds?: ReadonlySet<string>
  onExpandSeenEvent?: (eventId: string) => void
}) {
  if (timelineGroups.length === 0) {
    return (
      <FriendlyEmptyState
        icon={AiSearchIcon}
        title="当前视图还没有信号"
        description="这个筛选条件下暂时没有新条目。你可以先去全部 AI 动态看全量时间线，再回来做更窄的筛选。"
        ctaLabel="查看全部 AI 动态"
        ctaTo="/ai-hotboard/view/all"
      />
    )
  }

  return (
    <div className="space-y-5">
      {timelineGroups.map((group) => (
        <section key={group.timestamp} className="grid grid-cols-[84px_minmax(0,1fr)] gap-3 sm:gap-4">
          <div className="pt-0.5">
            <div className="flex gap-2">
              <div className="flex flex-col items-center">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                <span className="mt-1 w-px flex-1 bg-gradient-to-b from-emerald-400/70 to-transparent" />
              </div>
              <div className="text-[38px] leading-none tracking-[-0.04em] text-slate-100 sm:text-[44px]" style={EDITORIAL_DISPLAY_STYLE}>
                {group.timestamp}
              </div>
            </div>
          </div>

          <div className="space-y-3">
            {group.events.map((event) => {
              const voteState = resolveVoteAggregate(event)
              const sourceUser = event.source_user?.trim()
              const isSeen = seenEventIds.has(event.id)
              const isCollapsedSeen = isSeen && !showSeenEvents && !expandedSeenEventIds.has(event.id)

              if (isCollapsedSeen) {
                return (
                  <article
                    key={event.id}
                    className={cn(HOTBOARD_CARD_CLASS, 'px-4 py-3 sm:px-5')}
                    style={HOTBOARD_CARD_STYLE}
                    data-testid="seen-event-collapsed"
                    data-event-id={event.id}
                  >
                    <button
                      type="button"
                      onClick={() => onExpandSeenEvent?.(event.id)}
                      className="flex w-full items-center justify-between gap-3 text-left"
                    >
                      <span className="min-w-0 truncate text-[1.35rem] leading-tight text-slate-200" style={EDITORIAL_DISPLAY_STYLE}>
                        {event.title}
                      </span>
                      <span className="shrink-0 rounded-full border border-slate-500/50 bg-slate-900/70 px-2.5 py-1 text-[11px] text-slate-400" style={EDITORIAL_MONO_STYLE}>
                        已读 · 点击展开
                      </span>
                    </button>
                  </article>
                )
              }

              return (
                <article
                  key={event.id}
                  className={cn(HOTBOARD_CARD_CLASS, 'px-4 py-4 sm:px-5 sm:py-5')}
                  style={HOTBOARD_CARD_STYLE}
                  data-event-id={event.id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-400" style={EDITORIAL_MONO_STYLE}>
                        <span className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
                        <span className="truncate">{event.condensedSourceLabel}</span>
                      </div>

                      <h2 className="text-[1.9rem] leading-[1.08] text-slate-100 sm:text-[2.15rem]" style={EDITORIAL_DISPLAY_STYLE}>
                        {event.title}
                      </h2>

                      {sourceUser ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className="inline-flex rounded-full border border-cyan-300/25 bg-cyan-400/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300/70"
                            data-testid="x-source-user-pill"
                            style={EDITORIAL_MONO_STYLE}
                          >
                            @{sourceUser}
                          </span>
                        </div>
                      ) : null}

                      <p className="text-[15px] leading-8 text-slate-200/92">{event.summary}</p>
                    </div>

                    <div className="flex shrink-0 items-start gap-2 pl-2">
                      <span
                        className={SIGNAL_BADGE_CLASS}
                        data-testid="signal-score-badge"
                        aria-label={`信号分 ${event.signalScore}`}
                        title="信号分: 基于标签 / 分类 / 互动综合评分, 60-99 为有效信号"
                      >
                        {event.signalScore}
                      </span>
                      <div className="flex gap-1 text-xs text-slate-400">
                        <button
                          type="button"
                          onClick={() => handleVoteClick(event.id, 'like', voteState)}
                          className={cn(
                            'cursor-pointer rounded-full border px-2 py-1 transition-all duration-200',
                            voteState.my_vote.includes('like')
                              ? 'border-emerald-300/70 bg-emerald-300/25 text-emerald-100'
                              : 'border-white/10 bg-slate-950/55 text-slate-400 hover:border-slate-400/40 hover:text-slate-200',
                          )}
                          aria-pressed={voteState.my_vote.includes('like')}
                          aria-label={`点赞 ${event.title}`}
                        >
                          👍 {voteState.like_count}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleVoteClick(event.id, 'dislike', voteState)}
                          className={cn(
                            'cursor-pointer rounded-full border px-2 py-1 transition-all duration-200',
                            voteState.my_vote.includes('dislike')
                              ? 'border-rose-300/70 bg-rose-300/25 text-rose-100'
                              : 'border-white/10 bg-slate-950/55 text-slate-400 hover:border-slate-400/40 hover:text-slate-200',
                          )}
                          aria-pressed={voteState.my_vote.includes('dislike')}
                          aria-label={`点踩 ${event.title}`}
                        >
                          👎 {voteState.dislike_count}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleVoteClick(event.id, 'bookmark', voteState)}
                          className={cn(
                            'cursor-pointer rounded-full border px-2 py-1 transition-all duration-200',
                            voteState.my_vote.includes('bookmark')
                              ? 'border-amber-300/70 bg-amber-300/25 text-amber-100'
                              : 'border-white/10 bg-slate-950/55 text-slate-400 hover:border-slate-400/40 hover:text-slate-200',
                          )}
                          aria-pressed={voteState.my_vote.includes('bookmark')}
                          aria-label={`收藏 ${event.title}`}
                        >
                          ☆ {voteState.bookmark_count}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
                    {event.tags.map((tag) => (
                      <span key={`${event.id}-${tag}`} className={cn('rounded-full border px-2 py-0.5 text-[11px]', getTagTone(tag))}>
                        {tag}
                      </span>
                    ))}
                    <span>· {event.signal_category}</span>
                    {event.aggregatedSourcesLabel ? (
                      <span className="rounded-full border border-slate-700/65 bg-slate-900/50 px-2 py-0.5 text-[11px] text-slate-300">
                        {event.aggregatedSourcesLabel}
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-3" data-testid="recommend-reason-banner">
                    <div className={RECOMMEND_BANNER_CLASS} data-recommend-banner="true" aria-label="推荐理由绿色条">
                      <div>{event.recommendReasonLine}</div>
                      <div className="mt-1 text-emerald-200/90">{event.actionLine}</div>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

export function AiHotboardScreen({
  source = 'all',
  page,
  strategyLine,
}: {
  source?: string
  page?: AiHotboardPage
  strategyLine?: string
}) {
  const effectivePage = normalizeHotboardPage(page ?? resolveHotboardPageFromSource(source))
  const resolvedSource = resolveSourceByHotboardPage(effectivePage, source)
  const normalizedSource = resolveFeedSourceForPage(effectivePage, toSupportedHotboardSource(resolvedSource))
  const feedMode = resolveFeedModeByPage(effectivePage)
  const { authUser, authResolved, authRequired, authCheckError, refreshAuth } = useAiHotboardAuth()

  const userIdRef = useRef<string>('unknown-user')
  const [isLoggingOut, setIsLoggingOut] = useState(false)

  const [remotePayload, setRemotePayload] = useState<MockPayload>(EMPTY_MOCK_PAYLOAD)
  const [remoteSourceLabel, setRemoteSourceLabel] = useState(DATA_SOURCE_LABEL)
  const [remoteGeneratedAt, setRemoteGeneratedAt] = useState(EMPTY_MOCK_PAYLOAD.generated_at)
  const [feedMeta, setFeedMeta] = useState<FeedMeta>(EMPTY_FEED_META)
  const [feedLoading, setFeedLoading] = useState(false)
  const [feedFetchError, setFeedFetchError] = useState<string | null>(null)
  const [voteAggregateByEvent, setVoteAggregateByEvent] = useState<VoteAggregateByEvent>({})
  const [seenUserId, setSeenUserId] = useState('unknown-user')
  const [seenEventIds, setSeenEventIds] = useState<Set<string>>(() => readSeenEventIds('unknown-user'))
  const [showSeenEvents, setShowSeenEvents] = useState(false)
  const [expandedSeenEventIds, setExpandedSeenEventIds] = useState<Set<string>>(() => new Set())

  const [intakeItemsByAgent, setIntakeItemsByAgent] = useState<Record<IntakeAgentKey, IntakeItem[]>>({
    hermes: [],
    xiaoj: [],
  })
  const [intakeLoadingByAgent, setIntakeLoadingByAgent] = useState<Record<IntakeAgentKey, boolean>>({
    hermes: false,
    xiaoj: false,
  })
  const [intakeErrorByAgent, setIntakeErrorByAgent] = useState<Record<IntakeAgentKey, string | null>>({
    hermes: null,
    xiaoj: null,
  })
  const [selectedIntakeItemIdByAgent, setSelectedIntakeItemIdByAgent] = useState<Record<IntakeAgentKey, string | null>>({
    hermes: null,
    xiaoj: null,
  })
  const [intakeDraftByAgent, setIntakeDraftByAgent] = useState<Record<IntakeAgentKey, { title: string; body: string; tagsText: string }>>({
    hermes: { title: '', body: '', tagsText: '' },
    xiaoj: { title: '', body: '', tagsText: '' },
  })
  const [intakeSubmittingByAgent, setIntakeSubmittingByAgent] = useState<Record<IntakeAgentKey, boolean>>({
    hermes: false,
    xiaoj: false,
  })
  const [intakeRequestErrorByAgent, setIntakeRequestErrorByAgent] = useState<Record<IntakeAgentKey, string | null>>({
    hermes: null,
    xiaoj: null,
  })

  const [strategyStatus, setStrategyStatus] = useState<StrategyStatusItem | null>(null)
  const [strategyStatusLoading, setStrategyStatusLoading] = useState(false)
  const [strategyStatusError, setStrategyStatusError] = useState<string | null>(null)
  const [wechatItems, setWechatItems] = useState<WechatArticleSummary[]>([])
  const [wechatLoading, setWechatLoading] = useState(false)
  const [wechatError, setWechatError] = useState<string | null>(null)
  const [wechatDraftUrl, setWechatDraftUrl] = useState('')
  const [wechatSubmitting, setWechatSubmitting] = useState(false)
  const [wechatRequestError, setWechatRequestError] = useState<string | null>(null)
  const [zaraItems, setZaraItems] = useState<ZaraYoutubeSummary[]>([])
  const [zaraLoading, setZaraLoading] = useState(false)
  const [zaraError, setZaraError] = useState<string | null>(null)
  const [zaraRefreshing, setZaraRefreshing] = useState(false)
  const [zaraRequestError, setZaraRequestError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadFeed() {
      if (!isFeedPage(effectivePage) || isPlaceholderSourcePage(effectivePage) || !authResolved || authRequired || authCheckError) {
        if (!cancelled) {
          setFeedLoading(false)
        }
        return
      }

      if (effectivePage === 'source-wechat') {
        if (!cancelled) {
          setFeedLoading(false)
          setWechatLoading(true)
          setWechatError(null)
        }

        try {
          const response = await fetch('/api/hotboard/wechat/feed?limit=50')
          if (!response.ok) throw new Error(`HTTP ${response.status}`)

          const body = (await response.json().catch(() => ({}))) as {
            items?: WechatArticleSummary[]
          }
          const items = Array.isArray(body.items) ? body.items : []

          if (cancelled) return

          setWechatItems(items)
          setWechatError(null)
          setRemotePayload({
            generated_at: new Date().toISOString(),
            note: 'source=wechat',
            events: items.map((item, index) =>
              mapFeedEventToMockEvent(
                {
                  ...item,
                  source: 'wechat',
                  fetched_at: new Date().toISOString(),
                },
                `api-wechat-${index}`,
                'wechat',
              ),
            ),
          })
          setRemoteSourceLabel('hotboard-wechat.sqlite')
          setRemoteGeneratedAt(items[0]?.publish_time || new Date().toISOString())
          return
        } catch (error) {
          if (!cancelled) {
            setWechatItems([])
            setWechatError(error instanceof Error ? error.message : '加载失败')
            setRemotePayload({
              generated_at: new Date().toISOString(),
              note: 'source=wechat',
              events: [],
            })
            setRemoteSourceLabel('hotboard-wechat.sqlite')
            setRemoteGeneratedAt(new Date().toISOString())
          }
          return
        } finally {
          if (!cancelled) {
            setWechatLoading(false)
          }
        }
      }

      if (effectivePage === 'source-zara-youtube') {
        if (!cancelled) {
          setFeedLoading(false)
          setZaraLoading(true)
          setZaraError(null)
        }

        try {
          const response = await fetch('/api/hotboard/zara/feed?limit=50')
          if (!response.ok) throw new Error(`HTTP ${response.status}`)

          const body = (await response.json().catch(() => ({}))) as {
            items?: ZaraYoutubeSummary[]
          }
          const items = Array.isArray(body.items) ? body.items : []

          if (cancelled) return

          setZaraItems(items)
          setZaraError(null)
          setRemotePayload({
            generated_at: new Date().toISOString(),
            note: 'source=zara-youtube',
            events: items.map((item, index) =>
              mapFeedEventToMockEvent(
                {
                  ...item,
                  source: 'zara-youtube',
                },
                `api-zara-${index}`,
                'zara-youtube',
              ),
            ),
          })
          setRemoteSourceLabel('hotboard-zara.sqlite')
          setRemoteGeneratedAt(items[0]?.lastRefreshedAt || items[0]?.firstSeenAt || new Date().toISOString())
          return
        } catch (error) {
          if (!cancelled) {
            setZaraItems([])
            setZaraError(error instanceof Error ? error.message : '加载失败')
            setRemotePayload({
              generated_at: new Date().toISOString(),
              note: 'source=zara-youtube',
              events: [],
            })
            setRemoteSourceLabel('hotboard-zara.sqlite')
            setRemoteGeneratedAt(new Date().toISOString())
          }
          return
        } finally {
          if (!cancelled) {
            setZaraLoading(false)
          }
        }
      }

      try {
        setFeedLoading(true)
        setFeedFetchError(null)
        const response = await fetch(
          `/api/hotboard/feed?source=${encodeURIComponent(normalizedSource)}`,
        )
        if (response.status === 401) {
          clearAiHotboardAuthCache({ broadcast: true, reason: 'logout' })
          window.location.href = '/ai-hotboard'
          return
        }
        if (!response.ok) throw new Error('feed request failed')

        const body = (await response.json().catch(() => ({}))) as {
          generated_at?: string
          data_source?: string
          meta?: Partial<FeedMeta>
          empty_reason?: FeedMeta['empty_reason']
          events?: Array<Record<string, unknown>>
        }

        const list = Array.isArray(body.events) ? body.events : []
        const normalizedEvents: MockEvent[] = list.map((item, index) =>
          mapFeedEventToMockEvent(item, `api-${normalizedSource}-${index}`, normalizedSource),
        )

        if (cancelled) return

        setFeedMeta(normalizeFeedMeta({ ...body.meta, empty_reason: body.empty_reason ?? body.meta?.empty_reason }))
        setRemotePayload({
          generated_at: String(body.generated_at ?? new Date().toISOString()),
          note: `source=${normalizedSource}`,
          events: normalizedEvents,
        })
        setRemoteSourceLabel(String(body.data_source ?? DATA_SOURCE_LABEL))
        setRemoteGeneratedAt(String(body.generated_at ?? new Date().toISOString()))
        return
      } catch (error) {
        console.error('[ai-hotboard] feed-fetch failed', error)
        if (!cancelled) {
          setFeedFetchError(error instanceof Error ? error.message : 'feed request failed')
        }
        // Keep fallback payload when feed API fails.
      } finally {
        if (!cancelled) {
          setFeedLoading(false)
        }
      }

      if (!cancelled) {
        const fallbackPayloadSource =
          import.meta.env.DEV === true
            ? ((await import(/* @vite-ignore */ `./${DATA_SOURCE_LABEL}`)).default as MockPayload)
            : EMPTY_MOCK_PAYLOAD
        const fallbackPayload = buildFeedFallbackPayload({
          isDev: import.meta.env.DEV === true,
          source: normalizedSource,
          generatedAt: fallbackPayloadSource.generated_at,
          note: fallbackPayloadSource.note,
          events: fallbackPayloadSource.events,
        })
        setRemotePayload(fallbackPayload)
        setRemoteSourceLabel(DATA_SOURCE_LABEL)
        setRemoteGeneratedAt(fallbackPayload.generated_at)
        setFeedMeta(EMPTY_FEED_META)
      }
    }

    void loadFeed()
    return () => {
      cancelled = true
    }
  }, [authCheckError, authRequired, authResolved, effectivePage, normalizedSource])

  const timelineEvents = useMemo<TimelineEvent[]>(() => {
    return remotePayload.events
      .slice()
      .map((event) => ({
        ...event,
        id: event.event_id?.trim() || event.id,
        timestamp: normalizeTimelineTimestamp(event.timestamp),
        signalScore: event.signal_score ?? computeSignalScore(event),
        actionLine: normalizeActionLine(event.suggested_action),
        recommendReasonLine: normalizeRecommendReason(event.recommend_reason),
        condensedSourceLabel: buildCondensedSourceLabel(event),
        aggregatedSourcesLabel: buildAggregatedSourcesLabel(event),
      }))
      .sort(
        (a, b) =>
          parseGeneratedAtValue(b.created_at ?? b.timestamp) -
          parseGeneratedAtValue(a.created_at ?? a.timestamp),
      )
  }, [remotePayload])

  const filteredTimelineEvents = useMemo(() => {
    return timelineEvents.filter((event) => feedMatchesMode(event, feedMode, voteAggregateByEvent))
  }, [timelineEvents, feedMode, voteAggregateByEvent])

  const timelineGroups = useMemo<TimelineGroup[]>(() => {
    const groups = new Map<string, TimelineGroup>()

    filteredTimelineEvents.forEach((event) => {
      const current = groups.get(event.timestamp)
      if (current) {
        current.events.push(event)
        return
      }

      groups.set(event.timestamp, {
        timestamp: event.timestamp,
        events: [event],
      })
    })

    return Array.from(groups.values())
  }, [filteredTimelineEvents])

  const feedStats = useMemo(
    () => buildFeedStats(filteredTimelineEvents, voteAggregateByEvent),
    [filteredTimelineEvents, voteAggregateByEvent],
  )

  const feedTimelineRootRef = useRef<HTMLDivElement | null>(null)
  const visibleFeedEventIdsSignature = useMemo(
    () => filteredTimelineEvents.map((event) => event.id).join('\n'),
    [filteredTimelineEvents],
  )

  useEffect(() => {
    setSeenEventIds(readSeenEventIds(seenUserId))
    setExpandedSeenEventIds(new Set())
  }, [seenUserId, effectivePage])

  useEffect(() => {
    if (!isFeedPage(effectivePage) || !feedTimelineRootRef.current || visibleFeedEventIdsSignature.length === 0) return
    return observeSeenEventDwell({
      root: feedTimelineRootRef.current,
      onSeen: (eventId) => {
        setSeenEventIds(writeSeenEventIds(seenUserId, [eventId]))
      },
    })
  }, [effectivePage, seenUserId, visibleFeedEventIdsSignature])

  function handleExpandSeenEvent(eventId: string) {
    setExpandedSeenEventIds((current) => {
      const next = new Set(current)
      next.add(eventId)
      return next
    })
  }

  useEffect(() => {
    if (authUser?.feishu_open_id || authUser?.email) {
      const nextUserId = authUser.feishu_open_id || authUser.email || authUser.id || 'unknown-user'
      userIdRef.current = nextUserId
      setSeenUserId(nextUserId)
      return
    }

    userIdRef.current = 'unknown-user'
    setSeenUserId('unknown-user')
  }, [authUser])

  useEffect(() => {
    let cancelled = false

    async function loadAggregate() {
      try {
        const response = await fetch('/api/hotboard/vote/aggregate')
        if (!response.ok) return
        const data = (await response.json().catch(() => ({}))) as {
          aggregate?: VoteAggregateByEvent
          user_id?: string
        }
        if (cancelled) return
        if (data.user_id && data.user_id.trim()) {
          userIdRef.current = data.user_id
          setSeenUserId(data.user_id)
        }
        setVoteAggregateByEvent(
          data.aggregate && typeof data.aggregate === 'object' ? data.aggregate : {},
        )
      } catch {
        // Keep default UI state on network errors.
      }
    }

    void loadAggregate()

    return () => {
      cancelled = true
    }
  }, [])

  const activeIntakeAgent: IntakeAgentKey | null =
    effectivePage === 'intake-hermes' ? 'hermes' : effectivePage === 'intake-xiaoj' ? 'xiaoj' : null

  useEffect(() => {
    let cancelled = false

    async function loadIntake(agent: IntakeAgentKey) {
      setIntakeLoadingByAgent((current) => ({ ...current, [agent]: true }))
      setIntakeErrorByAgent((current) => ({ ...current, [agent]: null }))

      try {
        const response = await fetch(`/api/hotboard/intake?author_agent=${encodeURIComponent(agent)}`)
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        const body = (await response.json().catch(() => ({}))) as {
          items?: IntakeItem[]
        }

        if (cancelled) return
        const items = Array.isArray(body.items) ? body.items : []
        setIntakeItemsByAgent((current) => ({ ...current, [agent]: items }))
        setSelectedIntakeItemIdByAgent((current) => ({
          ...current,
          [agent]: current[agent] && items.some((item) => item.id === current[agent]) ? current[agent] : items[0]?.id ?? null,
        }))
      } catch (error) {
        if (cancelled) return
        setIntakeErrorByAgent((current) => ({
          ...current,
          [agent]: error instanceof Error ? error.message : '加载失败',
        }))
      } finally {
        if (!cancelled) {
          setIntakeLoadingByAgent((current) => ({ ...current, [agent]: false }))
        }
      }
    }

    if (activeIntakeAgent) {
      void loadIntake(activeIntakeAgent)
    }

    return () => {
      cancelled = true
    }
  }, [activeIntakeAgent])

  const normalizedStrategyLine = resolveStrategyLineKey(strategyLine)

  useEffect(() => {
    let cancelled = false

    async function loadStrategyStatus() {
      if (effectivePage !== 'strategy-line') return

      setStrategyStatusLoading(true)
      setStrategyStatusError(null)

      try {
        const response = await fetch(
          `/api/hotboard/strategy?line=${encodeURIComponent(normalizedStrategyLine)}`,
        )

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        const body = (await response.json().catch(() => ({}))) as {
          item?: StrategyStatusItem
        }

        if (cancelled) return

        setStrategyStatus(body.item ?? null)
      } catch (error) {
        if (cancelled) return
        setStrategyStatus(null)
        setStrategyStatusError(error instanceof Error ? error.message : '加载失败')
      } finally {
        if (!cancelled) {
          setStrategyStatusLoading(false)
        }
      }
    }

    void loadStrategyStatus()

    return () => {
      cancelled = true
    }
  }, [effectivePage, normalizedStrategyLine])

  async function handleLogout() {
    if (isLoggingOut) return
    setIsLoggingOut(true)
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
      })
      clearAiHotboardAuthCache({ broadcast: true, reason: 'logout' })
    } finally {
      window.location.href = '/ai-hotboard'
    }
  }

  async function refreshWechatFeed() {
    setWechatLoading(true)
    setWechatError(null)

    try {
      const response = await fetch('/api/hotboard/wechat/feed?limit=50')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const body = (await response.json().catch(() => ({}))) as {
        items?: WechatArticleSummary[]
      }
      const items = Array.isArray(body.items) ? body.items : []

      setWechatItems(items)
      setRemotePayload({
        generated_at: new Date().toISOString(),
        note: 'source=wechat',
        events: items.map((item, index) =>
          mapFeedEventToMockEvent(
            {
              ...item,
              source: 'wechat',
              fetched_at: new Date().toISOString(),
            },
            `api-wechat-${index}`,
            'wechat',
          ),
        ),
      })
      setRemoteSourceLabel('hotboard-wechat.sqlite')
      setRemoteGeneratedAt(items[0]?.publish_time || new Date().toISOString())
    } catch (error) {
      setWechatError(error instanceof Error ? error.message : '加载失败')
    } finally {
      setWechatLoading(false)
    }
  }

  async function submitWechatUrl() {
    const url = wechatDraftUrl.trim()
    if (!url) {
      setWechatRequestError('URL 不能为空')
      return
    }

    setWechatRequestError(null)
    setWechatSubmitting(true)

    try {
      const response = await fetch('/api/hotboard/wechat/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      })

      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
      }

      if (!response.ok || !body.ok) {
        throw new Error(body.error || `HTTP ${response.status}`)
      }

      setWechatDraftUrl('')
      await refreshWechatFeed()
    } catch (error) {
      setWechatRequestError(error instanceof Error ? error.message : '提交失败')
    } finally {
      setWechatSubmitting(false)
    }
  }

  async function refreshZaraFeed() {
    setZaraRequestError(null)
    setZaraRefreshing(true)

    try {
      const response = await fetch('/api/hotboard/zara/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      })

      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
      }

      if (!response.ok || !body.ok) {
        throw new Error(body.error || `HTTP ${response.status}`)
      }

      setZaraLoading(true)
      const feedResponse = await fetch('/api/hotboard/zara/feed?limit=50')
      if (!feedResponse.ok) throw new Error(`HTTP ${feedResponse.status}`)
      const feedBody = (await feedResponse.json().catch(() => ({}))) as { items?: ZaraYoutubeSummary[] }
      const items = Array.isArray(feedBody.items) ? feedBody.items : []
      setZaraItems(items)
      setRemotePayload({
        generated_at: new Date().toISOString(),
        note: 'source=zara-youtube',
        events: items.map((item, index) =>
          mapFeedEventToMockEvent(
            {
              ...item,
              source: 'zara-youtube',
            },
            `api-zara-${index}`,
            'zara-youtube',
          ),
        ),
      })
      setRemoteSourceLabel('hotboard-zara.sqlite')
      setRemoteGeneratedAt(items[0]?.lastRefreshedAt || items[0]?.firstSeenAt || new Date().toISOString())
    } catch (error) {
      setZaraRequestError(error instanceof Error ? error.message : '刷新失败')
    } finally {
      setZaraRefreshing(false)
      setZaraLoading(false)
    }
  }

  function resolveVoteAggregate(event: TimelineEvent): VoteAggregateEntry {
    const existing = voteAggregateByEvent[event.id]
    if (existing) return existing
    return {
      like_count: event.engagement.likes,
      dislike_count: event.engagement.dislikes,
      bookmark_count: event.engagement.bookmarks,
      my_vote: [],
    }
  }

  async function handleVoteClick(eventId: string, voteType: VoteType, baseline?: VoteAggregateEntry) {
    const previous = voteAggregateByEvent[eventId] ?? baseline ?? {
      like_count: 0,
      dislike_count: 0,
      bookmark_count: 0,
      my_vote: [],
    }

    const wasActive = previous.my_vote.includes(voteType)
    const nextCountDelta = wasActive ? -1 : 1
    const optimisticNext: VoteAggregateEntry = {
      like_count: previous.like_count,
      dislike_count: previous.dislike_count,
      bookmark_count: previous.bookmark_count,
      my_vote: wasActive ? previous.my_vote.filter((vote) => vote !== voteType) : [...previous.my_vote, voteType].sort(),
    }

    if (voteType === 'like') optimisticNext.like_count = Math.max(0, previous.like_count + nextCountDelta)
    if (voteType === 'dislike') optimisticNext.dislike_count = Math.max(0, previous.dislike_count + nextCountDelta)
    if (voteType === 'bookmark') optimisticNext.bookmark_count = Math.max(0, previous.bookmark_count + nextCountDelta)

    setVoteAggregateByEvent((current) => ({
      ...current,
      [eventId]: optimisticNext,
    }))

    try {
      const response = await fetch('/api/hotboard/vote', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          event_id: eventId,
          vote_type: voteType,
        }),
      })

      if (!response.ok) {
        throw new Error('vote request failed')
      }

      const data = (await response.json().catch(() => ({}))) as {
        aggregate?: VoteAggregateByEvent
        user_id?: string
      }

      if (data.user_id && data.user_id.trim()) {
        userIdRef.current = data.user_id
      }

      if (data.aggregate && typeof data.aggregate === 'object') {
        setVoteAggregateByEvent(data.aggregate)
      }
    } catch {
      setVoteAggregateByEvent((current) => ({
        ...current,
        [eventId]: previous,
      }))
    }
  }

  async function refreshIntake(agent: IntakeAgentKey) {
    setIntakeLoadingByAgent((current) => ({ ...current, [agent]: true }))
    setIntakeErrorByAgent((current) => ({ ...current, [agent]: null }))

    try {
      const response = await fetch(`/api/hotboard/intake?author_agent=${encodeURIComponent(agent)}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json().catch(() => ({}))) as { items?: IntakeItem[] }
      const items = Array.isArray(body.items) ? body.items : []

      setIntakeItemsByAgent((current) => ({ ...current, [agent]: items }))
      setSelectedIntakeItemIdByAgent((current) => ({ ...current, [agent]: items[0]?.id ?? null }))
    } catch (error) {
      setIntakeErrorByAgent((current) => ({
        ...current,
        [agent]: error instanceof Error ? error.message : '加载失败',
      }))
    } finally {
      setIntakeLoadingByAgent((current) => ({ ...current, [agent]: false }))
    }
  }

  async function submitIntake(agent: IntakeAgentKey) {
    const draft = intakeDraftByAgent[agent]
    const title = draft.title.trim()
    const body = draft.body.trim()
    const tags = draft.tagsText
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)

    if (!title || !body) {
      setIntakeRequestErrorByAgent((current) => ({
        ...current,
        [agent]: '标题和正文不能为空',
      }))
      return
    }

    setIntakeRequestErrorByAgent((current) => ({ ...current, [agent]: null }))
    setIntakeSubmittingByAgent((current) => ({ ...current, [agent]: true }))

    try {
      const response = await fetch('/api/hotboard/intake', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          author_agent: agent,
          title,
          body,
          tags,
        }),
      })

      const bodyJson = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
      }

      if (!response.ok || !bodyJson.ok) {
        throw new Error(bodyJson.error || `HTTP ${response.status}`)
      }

      setIntakeDraftByAgent((current) => ({
        ...current,
        [agent]: { title: '', body: '', tagsText: '' },
      }))

      await refreshIntake(agent)
    } catch (error) {
      setIntakeRequestErrorByAgent((current) => ({
        ...current,
        [agent]: error instanceof Error ? error.message : '提交失败',
      }))
    } finally {
      setIntakeSubmittingByAgent((current) => ({ ...current, [agent]: false }))
    }
  }

  const feedHeading = getFeedHeading(effectivePage)
  const visibleSystemNavItems = getVisibleSystemNavItems(authUser)
  const visibleRemoteSourceLabel = resolveVisibleSourceLabel(remoteSourceLabel, authUser)
  const showExpandedFeedChrome = shouldShowExpandedFeedChrome(effectivePage)
  const compactStatusLoading =
    feedLoading ||
    (effectivePage === 'source-wechat' && wechatLoading) ||
    (effectivePage === 'source-zara-youtube' && (zaraLoading || zaraRefreshing))
  const compactStatusHasError = Boolean(
    feedFetchError ||
      feedMeta.stale ||
      feedMeta.partial_failures.length > 0 ||
      (effectivePage === 'source-wechat' && wechatError) ||
      (effectivePage === 'source-zara-youtube' && zaraError),
  )

  const renderMainPanel = () => {
    if (isPlaceholderSourcePage(effectivePage)) {
      return <JcHumanTalksComingSoonCard />
    }


    if (effectivePage === 'intake-hermes' || effectivePage === 'intake-xiaoj') {
      const panelTitle = effectivePage === 'intake-hermes' ? '爱马仕战略发现' : '小J 执行发现'
      const agent = effectivePage === 'intake-hermes' ? 'hermes' : 'xiaoj'

      return (
        <IntakePanel
          authorAgent={agent}
          title={panelTitle}
          authUser={authUser}
          items={intakeItemsByAgent[agent]}
          selectedItemId={selectedIntakeItemIdByAgent[agent]}
          onSelectItem={(id) => {
            setSelectedIntakeItemIdByAgent((current) => ({ ...current, [agent]: id }))
          }}
          draft={intakeDraftByAgent[agent]}
          onDraftChange={(next) => {
            setIntakeDraftByAgent((current) => ({
              ...current,
              [agent]: {
                ...current[agent],
                ...next,
              },
            }))
          }}
          onSubmit={() => {
            void submitIntake(agent)
          }}
          submitting={intakeSubmittingByAgent[agent]}
          requestError={intakeRequestErrorByAgent[agent]}
          listLoading={intakeLoadingByAgent[agent]}
          listError={intakeErrorByAgent[agent]}
        />
      )
    }

    if (effectivePage === 'strategy-line') {
      return (
        <StrategyPanel
          strategyLine={normalizedStrategyLine}
          item={strategyStatus}
          loading={strategyStatusLoading}
          error={strategyStatusError}
          authUser={authUser}
        />
      )
    }

    if (effectivePage === 'iteration') {
      return <IterationPanel />
    }

    if (effectivePage === 'system' || effectivePage === 'user' || effectivePage === 'logout') {
      return <BasicPagePanel page={effectivePage} onLogout={() => { void handleLogout() }} isLoggingOut={isLoggingOut} authUser={authUser} />
    }

    if (effectivePage === 'source-wechat') {
      return (
        <>
          <WechatIngestPanel
            authUser={authUser}
            draftUrl={wechatDraftUrl}
            onDraftUrlChange={setWechatDraftUrl}
            onSubmit={() => {
              void submitWechatUrl()
            }}
            submitting={wechatSubmitting}
            requestError={wechatRequestError}
          />

          {wechatLoading ? (
            <section className={HOTBOARD_SECTION_CLASS} style={HOTBOARD_CARD_STYLE}>
              <div className="text-sm text-slate-300">正在读取公众号 feed...</div>
            </section>
          ) : null}

          {wechatError ? (
            <section className={HOTBOARD_SECTION_CLASS} style={HOTBOARD_CARD_STYLE}>
              <div className="text-sm text-rose-100">公众号 feed 读取失败：{wechatError}</div>
            </section>
          ) : null}

          <div ref={feedTimelineRootRef}>
            <FeedTimeline
              timelineGroups={timelineGroups}
              resolveVoteAggregate={resolveVoteAggregate}
              handleVoteClick={handleVoteClick}
              seenEventIds={seenEventIds}
              showSeenEvents={showSeenEvents}
              expandedSeenEventIds={expandedSeenEventIds}
              onExpandSeenEvent={handleExpandSeenEvent}
            />
          </div>
        </>
      )
    }

    if (effectivePage === 'source-zara-youtube') {
      return (
        <>
          <ZaraRefreshPanel
            authUser={authUser}
            onRefresh={() => {
              void refreshZaraFeed()
            }}
            refreshing={zaraRefreshing}
            requestError={zaraRequestError}
          />

          {zaraLoading ? (
            <section className={HOTBOARD_SECTION_CLASS} style={HOTBOARD_CARD_STYLE}>
              <div className="text-sm text-slate-300">正在读取 Zara YouTube 精选...</div>
            </section>
          ) : null}

          {zaraError ? (
            <section className={HOTBOARD_SECTION_CLASS} style={HOTBOARD_CARD_STYLE}>
              <div className="text-sm text-rose-100">Zara 源读取失败：{zaraError}</div>
            </section>
          ) : null}

          <ZaraYoutubeTimeline items={zaraItems} />
        </>
      )
    }

    if (isFeedPage(effectivePage) && timelineGroups.length === 0) {
      const emptyStateCopy = getEmptyStateCopy(feedMeta)
      return (
        <>
          <FeedErrorBanners authCheckError={authCheckError} feedFetchError={feedFetchError} />
          <FeedMetaBanners meta={feedMeta} />
          <FriendlyEmptyState
            icon={AiSearchIcon}
            title={emptyStateCopy.title}
            description={emptyStateCopy.description}
            ctaLabel="查看信源健康"
            ctaTo="/ai-hotboard/sources/health"
          />
        </>
      )
    }

    return (
      <>
        {showExpandedFeedChrome ? (
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <HotboardStatCard
              label="EVENTS"
              value={feedStats.totalEvents}
              icon={ActivitySparkIcon}
              helper="实时进入看板的事件条目"
              trendLabel="FLOW"
              tone="cyan"
            />
            <HotboardStatCard
              label="LIKES"
              value={feedStats.totalLikes}
              icon={AnalyticsUpIcon}
              helper="点赞回流代表即时热度"
              trendLabel="HEAT"
              tone="emerald"
            />
            <HotboardStatCard
              label="BOOKMARKS"
              value={feedStats.totalBookmarks}
              icon={Bookmark02Icon}
              helper="收藏是更高意图的沉淀"
              trendLabel="SAVE"
              tone="amber"
            />
            <HotboardStatCard
              label="AVG SIGNAL"
              value={feedStats.averageSignalScore}
              icon={AnalyticsUpIcon}
              helper="综合信号强度均值"
              trendLabel="HIGH"
              tone="cyan"
            />
          </section>
        ) : null}

        <FeedErrorBanners authCheckError={authCheckError} feedFetchError={feedFetchError} />

        <FeedMetaBanners meta={feedMeta} />

        <div ref={feedTimelineRootRef}>
          <FeedTimeline
            timelineGroups={timelineGroups}
            resolveVoteAggregate={resolveVoteAggregate}
            handleVoteClick={handleVoteClick}
            seenEventIds={seenEventIds}
            showSeenEvents={showSeenEvents}
            expandedSeenEventIds={expandedSeenEventIds}
            onExpandSeenEvent={handleExpandSeenEvent}
          />
        </div>
      </>
    )
  }

  if (!authResolved) {
    return (
      <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950 text-slate-200">
        正在检查登录状态...
      </div>
    )
  }

  if (authCheckError) {
    return (
      <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950 px-5 text-slate-100">
        <section className="w-full max-w-lg rounded-[28px] border border-red-300/25 bg-slate-900/90 p-6 shadow-[0_24px_72px_rgba(2,6,23,0.52)]">
          <div className="text-[11px] tracking-[0.3em] text-red-200/80">AUTH CHECK FAILED</div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">身份核验失败</h1>
          <p className="mt-3 text-sm leading-6 text-slate-300">看板已暂停渲染, 请重试身份核验或联系 JC。</p>
          <p className="mt-3 rounded-2xl border border-red-300/20 bg-red-400/10 px-3 py-2 text-xs text-red-100">
            {authCheckError}
          </p>
          <button
            type="button"
            onClick={() => { void refreshAuth() }}
            className={cn(HOTBOARD_SECONDARY_BUTTON_CLASS, 'mt-5 border-cyan-300/35 text-cyan-100 hover:border-cyan-200/60')}
          >
            重试身份核验
          </button>
        </section>
      </div>
    )
  }

  if (authRequired) {
    return <LoginScreen />
  }

  return (
    <div className="fixed inset-0 z-[120] overflow-y-auto text-slate-100" style={HOTBOARD_BACKGROUND_STYLE}>
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-24 top-0 h-[26rem] w-[26rem] rounded-full bg-cyan-300/12 blur-[120px]" />
        <div className="absolute right-[-8rem] top-20 h-[22rem] w-[22rem] rounded-full bg-amber-300/10 blur-[140px]" />
        <div className="absolute bottom-[-10rem] left-1/3 h-[24rem] w-[24rem] rounded-full bg-sky-500/8 blur-[150px]" />
      </div>

      <div className="relative mx-auto flex min-h-screen w-full max-w-[1480px] gap-4 px-3 py-4 sm:gap-5 sm:px-4 lg:px-6">
        <aside
          className={cn(HOTBOARD_PANEL_CLASS, 'w-[252px] shrink-0 rounded-[30px] p-4')}
          aria-label="AI HOT 左侧导航"
          style={HOTBOARD_SIDEBAR_STYLE}
        >
          <div className="mb-4 rounded-[24px] border border-white/10 bg-slate-950/55 px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]" style={HOTBOARD_CARD_STYLE}>
            <div className="text-[11px] tracking-[0.34em] text-slate-500" style={EDITORIAL_MONO_STYLE}>SIGNAL BOARD</div>
            <div className="mt-3 flex items-center gap-2 text-cyan-300">
              <span className="text-[2rem] leading-none text-slate-100" style={EDITORIAL_DISPLAY_STYLE}>AI</span>
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-cyan-300/65 text-base leading-none text-cyan-300 shadow-[0_0_32px_rgba(34,211,238,0.18)] animate-pulse [animation-duration:6s]">
                ○
              </span>
              <span className="text-[2rem] leading-none" style={EDITORIAL_DISPLAY_STYLE}>HOT</span>
            </div>
            <p className="mt-3 text-sm leading-6 text-slate-300">Editorial darkroom for signal triage, source review, and human-in-the-loop curation.</p>
          </div>

          <nav className="space-y-3" aria-label="AI HOT 导航列表">
            <LinkNavItems
              items={PRIMARY_NAV_ITEMS}
              highlightedKey={feedPageHighlightedNavKey(effectivePage)}
              exactHighlights
            />
            <SourceRouteItems highlightedPage={effectivePage} />
            <SidebarSectionLinkGroup title="信源提报" items={INTAKE_ROUTE_ITEMS} highlightedKey={intakeHighlightedKey(effectivePage)} />

            <div className="px-1 text-xs tracking-[0.24em] text-slate-500" style={EDITORIAL_MONO_STYLE}>策略</div>
            <SidebarSectionLinkGroup
              title="策略线路"
              items={STRATEGY_ROUTE_ITEMS}
              highlightedKey={effectivePage === 'strategy-line' ? strategyHighlightedKey(normalizedStrategyLine) : undefined}
              testId="featured-strategy-section"
            />
            <SidebarSectionLinkGroup
              title="策略迭代"
              items={[{ key: 'iteration', label: '策略迭代总览', to: '/ai-hotboard/iteration' }]}
              highlightedKey={effectivePage === 'iteration' ? 'iteration' : undefined}
              testId="strategy-iteration-section"
            />

            {visibleSystemNavItems.length > 0 ? (
              <>
                <div className="px-1 text-xs tracking-[0.24em] text-slate-500" style={EDITORIAL_MONO_STYLE}>后台</div>
                <LinkNavItems items={visibleSystemNavItems} highlightedKey={systemPageHighlightedNavKey(effectivePage)} />
              </>
            ) : null}
          </nav>
        </aside>

        <main
          className={cn(HOTBOARD_PANEL_CLASS, 'min-w-0 flex-1 rounded-[32px] p-4 sm:p-5 lg:p-6')}
          style={HOTBOARD_PANEL_STYLE}
        >
          <header className="mb-6 flex flex-col gap-4 rounded-[26px] border border-white/10 px-5 py-5 shadow-[0_24px_56px_rgba(2,6,23,0.36),inset_0_1px_0_rgba(255,255,255,0.04)] sm:flex-row sm:items-end sm:justify-between" style={HOTBOARD_CARD_STYLE}>
            <div>
              <div className="text-[11px] tracking-[0.32em] text-cyan-300/80" style={EDITORIAL_MONO_STYLE}>AI HOTBOARD</div>
              <h1 className="mt-3 text-[2.9rem] leading-none text-slate-100 sm:text-[3.55rem]" style={EDITORIAL_DISPLAY_STYLE}>
                {feedHeading.title}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-300 sm:text-[15px]">{feedHeading.subtitle}</p>
            </div>
            <div className="flex min-w-[19rem] flex-col gap-2 rounded-[20px] border border-white/10 bg-slate-950/55 px-4 py-3 text-sm text-slate-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              {showExpandedFeedChrome ? (
                <>
                  <div className="text-[11px] tracking-[0.2em] text-slate-500" style={EDITORIAL_MONO_STYLE}>LIVE META</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500" style={EDITORIAL_MONO_STYLE}>更新时间</div>
                      <div className="mt-1 text-slate-100">{formatGeneratedAt(remoteGeneratedAt)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500" style={EDITORIAL_MONO_STYLE}>数据来源</div>
                      <div className="mt-1 truncate text-slate-100">{visibleRemoteSourceLabel}</div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="min-w-0 space-y-2 text-xs leading-5 text-slate-300">
                  <div>
                    <div className="truncate tracking-[0.18em] text-cyan-300/80" style={EDITORIAL_MONO_STYLE}>AI HOTBOARD / {feedHeading.title}</div>
                    <div className="mt-1 truncate text-slate-400">更新 {formatGeneratedAt(remoteGeneratedAt)} · 来源 {visibleRemoteSourceLabel}</div>
                  </div>
                  {isFeedPage(effectivePage) ? (
                    <HotboardStatusChip
                      loading={compactStatusLoading}
                      hasError={compactStatusHasError}
                      visibleCount={filteredTimelineEvents.length}
                      totalCount={timelineEvents.length}
                    />
                  ) : null}
                </div>
              )}
              <div className="mt-1 flex items-center justify-between gap-2 rounded-[16px] border border-white/10 bg-slate-900/55 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                <div className="min-w-0">
                  <div className="truncate text-sm text-slate-100">欢迎 {authUser?.display_name ?? '未登录'}</div>
                  <div
                    className={cn(
                      'mt-1 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-[0.18em]',
                      authUser?.role === 'owner'
                        ? 'border-amber-300/80 bg-amber-400/10 text-amber-200'
                        : 'border-slate-500/60 bg-slate-700/25 text-slate-300',
                    )}
                    style={EDITORIAL_MONO_STYLE}
                  >
                    {authUser?.role === 'owner' ? 'OWNER' : 'MEMBER'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void handleLogout()
                  }}
                  disabled={isLoggingOut}
                  className={cn(HOTBOARD_SECONDARY_BUTTON_CLASS, 'border-amber-300/20 text-slate-100 hover:border-amber-200/45')}
                >
                  {isLoggingOut ? '切换中...' : '切换账号'}
                </button>
              </div>
              {isFeedPage(effectivePage) ? (
                <SeenEventsToggle
                  showSeenEvents={showSeenEvents}
                  onToggle={() => setShowSeenEvents((value) => !value)}
                />
              ) : null}
            </div>
          </header>

          <div className="space-y-5">{renderMainPanel()}</div>
        </main>
      </div>
    </div>
  )
}
