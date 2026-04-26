export type HotboardSource = 'x-bookmarks' | 'x-likes' | 'x-following' | 'x-for_you' | 'wechat' | 'zara-youtube' | 'all'

export type MockEvent = {
  id: string
  event_id?: string
  timestamp: string
  created_at?: string
  source_type: string
  source_name: string
  source_channel: string
  title: string
  summary: string
  tags: string[]
  signal_category: string
  signal_score?: number
  aggregated_sources_count: number
  engagement: {
    likes: number
    dislikes: number
    bookmarks: number
  }
  recommend_reason: string
  suggested_action: string
  source_user?: string
}

const SUPPORTED_SOURCES: HotboardSource[] = [
  'x-bookmarks',
  'x-likes',
  'x-following',
  'x-for_you',
  'wechat',
  'zara-youtube',
  'all',
]

export function toSupportedHotboardSource(source: string): HotboardSource {
  if (SUPPORTED_SOURCES.includes(source as HotboardSource)) {
    return source as HotboardSource
  }
  return 'all'
}

export function parseGeneratedAtValue(value: string) {
  const trimmed = value.trim()
  const match = trimmed.match(/^(\d{1,2}):(\d{1,2})$/)
  if (match) {
    const hour = Number(match[1])
    const minute = Number(match[2])
    return hour * 60 + minute
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 0
  return date.getTime()
}

export function mapFeedEventToMockEvent(
  item: Record<string, unknown>,
  fallbackId: string,
  fallbackSourceChannel: string,
): MockEvent {
  if (String(item.source ?? fallbackSourceChannel) === 'wechat') {
    const author = String(item.author ?? '').trim()
    const publishedAt = String(item.publish_time ?? item.fetched_at ?? '')
    return {
      id: String(item.id ?? fallbackId),
      event_id: String(item.id ?? fallbackId),
      timestamp: publishedAt,
      created_at: publishedAt,
      source_type: '公众号',
      source_name: author || '微信文章',
      source_channel: 'wechat',
      title: String(item.title ?? '公众号文章'),
      summary: String(item.excerpt ?? ''),
      tags: ['公众号', '手工投递'],
      signal_category: '同行动作',
      signal_score: 82,
      aggregated_sources_count: 0,
      engagement: {
        likes: 0,
        dislikes: 0,
        bookmarks: 0,
      },
      recommend_reason: '推荐理由：来自公众号手工投递抓取',
      suggested_action: '更新战略：判断这篇文章是否要进入热点看板精选流',
    }
  }

  if (String(item.source ?? fallbackSourceChannel) === 'zara-youtube') {
    const channel = String(item.channel ?? '').trim()
    const publishedAt = String(item.firstSeenAt ?? item.lastRefreshedAt ?? '')
    const tags = Array.isArray(item.tags)
      ? item.tags.map((tag) => String(tag).trim()).filter(Boolean)
      : []

    return {
      id: String(item.videoId ?? fallbackId),
      event_id: String(item.videoId ?? fallbackId),
      timestamp: publishedAt,
      created_at: publishedAt,
      source_type: 'YouTube',
      source_name: channel || 'Zara curated',
      source_channel: 'zara-youtube',
      title: String(item.title ?? 'Zara YouTube 精选'),
      summary: String(item.description ?? ''),
      tags: tags.length > 0 ? tags : ['Zara curated'],
      signal_category: '同行动作',
      signal_score: 85,
      aggregated_sources_count: 0,
      engagement: {
        likes: 0,
        dislikes: 0,
        bookmarks: 0,
      },
      recommend_reason: '推荐理由：来自 Zara Zhang 的 AI 学习库精选视频',
      suggested_action: '更新战略：判断这条视频是否值得沉淀到 AI 热点长期知识流',
    }
  }

  const likes = Number(item.likes ?? 0)
  const signalScore = Number(item.signal_score ?? 0)
  const sourceLine = String(item.source_line ?? 'Signal Feed')
  const sourceUser = String(item.source_user ?? '').trim()
  const sourceNameParts = sourceLine
    .split('·')
    .map((segment) => segment.trim())
    .filter(Boolean)

  const sourceName =
    sourceNameParts.length >= 2 ? sourceNameParts.slice(0, 2).join(' · ') : sourceLine

  return {
    id: String(item.event_id ?? fallbackId),
    event_id: String(item.event_id ?? fallbackId),
    timestamp: String(item.created_at ?? ''),
    created_at: String(item.created_at ?? ''),
    source_type: 'X',
    source_name: sourceName,
    source_channel: String(item.source ?? fallbackSourceChannel),
    title: String(item.title ?? 'X 信号更新'),
    summary: String(item.summary ?? ''),
    tags: ['X', '实时'],
    signal_category: '同行动作',
    signal_score: Number.isFinite(signalScore) ? signalScore : 0,
    aggregated_sources_count: 0,
    engagement: {
      likes: Number.isFinite(likes) ? likes : 0,
      dislikes: 0,
      bookmarks: 0,
    },
    recommend_reason: '推荐理由：来自 X 实时信号同步',
    suggested_action: '触发 skill：x-signal-review（高价值信号二次判断）',
    source_user: sourceUser,
  }
}

export function buildFallbackEventsFromMock(source: string, events: MockEvent[]) {
  return events.map((event) => ({
    ...event,
    created_at: event.timestamp,
    source_channel: source,
  }))
}

export function buildFeedFallbackPayload({
  isDev,
  source,
  generatedAt,
  note,
  events,
}: {
  isDev: boolean
  source: string
  generatedAt: string
  note: string
  events: MockEvent[]
}) {
  if (!isDev) {
    return {
      generated_at: new Date().toISOString(),
      note: 'empty-feed',
      events: [],
    }
  }

  return {
    generated_at: generatedAt,
    note,
    events: buildFallbackEventsFromMock(source, events),
  }
}

export function normalizeTimelineTimestamp(timestamp: string) {
  const trimmed = timestamp.trim()
  const match = trimmed.match(/^(\d{1,2}):(\d{1,2})$/)

  if (!match) {
    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) {
      return new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(parsed))
    }
    return trimmed
  }

  const [, hour, minute] = match
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
}
