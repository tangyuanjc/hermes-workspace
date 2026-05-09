// @vitest-environment jsdom
import { createElement } from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  buildFeedStats,
  FeedErrorBanners,
  FeedMetaBanners,
  FeedTimeline,
  feedMatchesMode,
  getSeenEventStorageKey,
  hashUserId,
  JcHumanTalksComingSoonCard,
  mergeSeenEventIds,
  normalizeFeedMeta,
  observeSeenEventDwell,
  parseSeenEventIds,
  readSeenEventIds,
  RECOMMEND_BANNER_CLASS,
  resolveFeedSourceForPage,
  SeenEventsToggle,
  SIDEBAR_NAV_SEQUENCE,
  SIGNAL_BADGE_CLASS,
  SOURCE_ITEMS,
  SOURCE_SUBMISSION_ITEMS,
  STRATEGY_ITERATION_ITEMS,
  STRATEGY_LINES,
  WechatIngestPanel,
  writeSeenEventIds,
  ZaraRefreshPanel,
  type TimelineEvent,
  type VoteAggregateByEvent,
} from './ai-hotboard-screen'
import type { AuthUser } from '@/lib/hermes-auth'

type MockIntersectionObserverEntry = Pick<IntersectionObserverEntry, 'target' | 'isIntersecting' | 'intersectionRatio'>

class MockIntersectionObserver {
  static latest: MockIntersectionObserver | null = null

  readonly elements = new Set<Element>()

  private readonly callback: IntersectionObserverCallback

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    MockIntersectionObserver.latest = this
  }

  observe = (element: Element) => {
    this.elements.add(element)
  }

  unobserve = (element: Element) => {
    this.elements.delete(element)
  }

  disconnect = () => {
    this.elements.clear()
  }

  takeRecords = () => []

  trigger(element: Element, visible: boolean) {
    const entry: MockIntersectionObserverEntry = {
      target: element,
      isIntersecting: visible,
      intersectionRatio: visible ? 1 : 0,
    }
    this.callback([entry as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  MockIntersectionObserver.latest = null
})

function makeTimelineEvent(overrides: Partial<TimelineEvent> & Pick<TimelineEvent, 'id'>): TimelineEvent {
  const { id, ...rest } = overrides
  return {
    id,
    event_id: id,
    timestamp: '10:00',
    created_at: '10:00',
    source_type: 'X',
    source_name: 'Test · Source',
    source_channel: 'x-for_you',
    title: 'title',
    summary: 'summary',
    tags: [],
    signal_category: 'other',
    signal_score: 80,
    aggregated_sources_count: 0,
    engagement: { likes: 10, dislikes: 0, bookmarks: 5 },
    recommend_reason: '',
    suggested_action: '',
    source_user: '',
    signalScore: 80,
    actionLine: '',
    recommendReasonLine: '',
    condensedSourceLabel: '',
    aggregatedSourcesLabel: null,
    ...rest,
  }
}

function makeAuthUser(overrides: Partial<AuthUser> & Pick<AuthUser, 'id' | 'role'>): AuthUser {
  const { id, ...rest } = overrides
  return {
    id,
    feishu_open_id: null,
    feishu_union_id: null,
    email: null,
    display_name: id,
    ...rest,
  }
}

describe('ai-hotboard screen handoff constraints', () => {
  it('keeps source and report subitems fully expanded by default', () => {
    expect(SOURCE_ITEMS).toEqual([
      'X bookmarks',
      'X likes',
      'X following',
      'X for_you',
      '公众号',
      'Zara YouTube 精选',
      'JC的人类对谈',
    ])

    expect(SOURCE_SUBMISSION_ITEMS).toEqual(['JC 苹果备忘录日记', '爱马仕战略发现', '小J 执行发现'])
  })

  it('keeps left navigation sequence fixed and renders M2 lines only once', () => {
    expect(SIDEBAR_NAV_SEQUENCE).toEqual([
      '全部 AI 动态',
      '热议帖 (基于互动比 · follower 数据待接入)',
      '收藏',
      '信源',
      '信源提报',
      '策略线路',
      '策略迭代',
      '系统',
      '用户',
      '信源健康',
      '退出',
    ])

    expect(STRATEGY_LINES).toEqual([
      'M2 A线 | 抓数稳定化',
      'M2 B线 | 财务报表自动化',
      'M2 C线 | AI短视频→投流ROI',
      'M2 D线 | 自动化有效率',
      'M2 E线 | 全员Agent协作',
    ])

    STRATEGY_LINES.forEach((line) => {
      expect(STRATEGY_ITERATION_ITEMS).not.toContain(line)
    })
  })

  it('uses fixed signal badge and recommendation banner styles', () => {
    expect(SIGNAL_BADGE_CLASS).toContain('h-8')
    expect(SIGNAL_BADGE_CLASS).toContain('w-8')
    expect(SIGNAL_BADGE_CLASS).toContain('bg-[#2a2f3e]')
    expect(SIGNAL_BADGE_CLASS).toContain('text-white')

    expect(RECOMMEND_BANNER_CLASS).toContain('bg-emerald-950/70')
    expect(RECOMMEND_BANNER_CLASS).not.toContain('border-l')
  })

  it('normalizes empty reason and renders stale source failure banner', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-06T13:00:00.000Z'))

    const meta = normalizeFeedMeta({
      status: 'stale',
      stale: true,
      partial_failures: ['missing_x_signal_latest'],
      empty_reason: 'source_failure',
      last_success_at: '2026-05-06T10:00:00.000Z',
      source_failure_reason: 'missing_x_signal_latest',
    })

    expect(meta.empty_reason).toBe('source_failure')
    expect(meta.status).toBe('stale')

    render(createElement(FeedMetaBanners, { meta }))
    expect(screen.getByText('数据源同步异常: missing_x_signal_latest')).toBeTruthy()
    expect(screen.getByText('数据上次成功更新 3 小时前 (信源故障)')).toBeTruthy()
  })
})

describe('FeedTimeline source user pill', () => {
  const voteAggregate = { like_count: 0, dislike_count: 0, bookmark_count: 0, my_vote: [] }

  it('renders a KOL pill for X events with source_user', () => {
    render(
      createElement(FeedTimeline, {
        timelineGroups: [{ timestamp: '10:00', events: [makeTimelineEvent({ id: 'evt-kol', source_user: 'builder' })] }],
        resolveVoteAggregate: () => voteAggregate,
        handleVoteClick: () => {},
      }),
    )

    expect(screen.getByTestId('x-source-user-pill').textContent).toBe('@builder')
    expect(screen.getByTestId('signal-score-badge').getAttribute('title')).toBe('信号分: 基于标签 / 分类 / 互动综合评分, 60-99 为有效信号')

    cleanup()
  })

  it('does not render a KOL pill when source_user is empty', () => {
    render(
      createElement(FeedTimeline, {
        timelineGroups: [{ timestamp: '10:00', events: [makeTimelineEvent({ id: 'evt-empty', source_user: '' })] }],
        resolveVoteAggregate: () => voteAggregate,
        handleVoteClick: () => {},
      }),
    )

    expect(screen.queryByTestId('x-source-user-pill')).toBeNull()

    cleanup()
  })
})

describe('FeedTimeline seen state', () => {
  const voteAggregate = { like_count: 0, dislike_count: 0, bookmark_count: 0, my_vote: [] }

  it('collapses seen events until the item is expanded or the toggle shows seen items', () => {
    const timelineGroups = [{ timestamp: '10:00', events: [makeTimelineEvent({ id: 'evt-seen', title: 'Seen title', summary: 'Seen summary' })] }]
    const props = {
      timelineGroups,
      resolveVoteAggregate: () => voteAggregate,
      handleVoteClick: () => {},
      seenEventIds: new Set(['evt-seen']),
    }

    const { rerender } = render(createElement(FeedTimeline, props))
    expect(screen.getByTestId('seen-event-collapsed')).toBeTruthy()
    expect(screen.getByText('已读 · 点击展开')).toBeTruthy()
    expect(screen.queryByText('Seen summary')).toBeNull()

    rerender(createElement(FeedTimeline, { ...props, expandedSeenEventIds: new Set(['evt-seen']) }))
    expect(screen.getByText('Seen summary')).toBeTruthy()

    rerender(createElement(FeedTimeline, { ...props, showSeenEvents: true }))
    expect(screen.getByText('Seen summary')).toBeTruthy()

    cleanup()
  })
})

describe('seen event storage helpers', () => {
  it('reads and writes user-scoped localStorage keys', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }

    expect(getSeenEventStorageKey(' user-1 ')).toBe(`ai-hotboard-seen-${hashUserId('user-1')}`)
    expect(getSeenEventStorageKey('ou_feishu_open_id_123')).not.toContain('ou_feishu_open_id_123')
    storage.setItem(getSeenEventStorageKey('user-1'), JSON.stringify(['old', '', 'old']))

    expect(Array.from(readSeenEventIds('user-1', storage))).toEqual(['old'])
    expect(Array.from(writeSeenEventIds('user-1', ['new'], storage))).toEqual(['old', 'new'])
    expect(parseSeenEventIds(storage.getItem(getSeenEventStorageKey('user-1')))).toEqual(['old', 'new'])
  })

  it('keeps seen ids FIFO-capped at the storage limit', () => {
    expect(mergeSeenEventIds(['a', 'b'], ['c', 'd'], 3)).toEqual(['b', 'c', 'd'])
    expect(mergeSeenEventIds(['a', 'b'], ['b', 'c'], 10)).toEqual(['a', 'b', 'c'])
  })
})

describe('observeSeenEventDwell', () => {
  it('marks an event as seen only after it stays visible for 2500ms', () => {
    vi.useFakeTimers()
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)

    const element = document.createElement('article')
    element.dataset.eventId = 'evt-visible'
    const seen: string[] = []

    const cleanupObserver = observeSeenEventDwell({
      root: document,
      onSeen: (eventId) => {
        seen.push(eventId)
      },
    })

    expect(MockIntersectionObserver.latest?.elements.has(element)).toBe(false)
    document.body.appendChild(element)
    cleanupObserver()

    const attachedCleanup = observeSeenEventDwell({
      root: document,
      onSeen: (eventId) => {
        seen.push(eventId)
      },
    })
    const observer = MockIntersectionObserver.latest
    expect(observer?.elements.has(element)).toBe(true)

    observer?.trigger(element, true)
    vi.advanceTimersByTime(2499)
    expect(seen).toEqual([])

    vi.advanceTimersByTime(1)
    expect(seen).toEqual(['evt-visible'])

    attachedCleanup()
  })

  it('does not mark an event if it leaves before dwell time completes', () => {
    vi.useFakeTimers()
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)

    const element = document.createElement('article')
    element.dataset.eventId = 'evt-quick-skip'
    document.body.appendChild(element)
    const seen: string[] = []

    const cleanupObserver = observeSeenEventDwell({
      root: document,
      onSeen: (eventId) => {
        seen.push(eventId)
      },
    })
    const observer = MockIntersectionObserver.latest

    observer?.trigger(element, true)
    vi.advanceTimersByTime(1200)
    observer?.trigger(element, false)
    vi.advanceTimersByTime(5000)

    expect(seen).toEqual([])

    cleanupObserver()
  })
})

describe('SeenEventsToggle', () => {
  it('toggles display of seen items with pressed state', () => {
    let toggled = 0
    const { rerender } = render(createElement(SeenEventsToggle, { showSeenEvents: false, onToggle: () => { toggled += 1 } }))

    expect(screen.getByRole('button', { name: '[ ] 显示已读' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: '[ ] 显示已读' }))
    expect(toggled).toBe(1)

    rerender(createElement(SeenEventsToggle, { showSeenEvents: true, onToggle: () => { toggled += 1 } }))
    expect(screen.getByRole('button', { name: '[x] 显示已读' }).getAttribute('aria-pressed')).toBe('true')

    cleanup()
  })
})

describe('resolveFeedSourceForPage', () => {
  it('routes low-follower view to the server-side proxy filter', () => {
    expect(resolveFeedSourceForPage('view-low-follower', 'all')).toBe('low-follower')
  })

  it('does not client-filter server low-follower results by like count', () => {
    expect(
      feedMatchesMode(
        makeTimelineEvent({ id: 'evt-server-low-follower', engagement: { likes: 999, dislikes: 0, bookmarks: 0 } }),
        'low-follower',
        {},
      ),
    ).toBe(true)
  })
})

describe('JcHumanTalksComingSoonCard', () => {
  it('renders relative coming-soon copy instead of hardcoded W19 metadata', () => {
    render(createElement(JcHumanTalksComingSoonCard))

    expect(screen.getByText('COMING SOON')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'JC 的人类对谈' })).toBeTruthy()
    expect(screen.getByText('由 JC 手工挑选 · 暂无新内容')).toBeTruthy()
    expect(screen.queryByText(/W19|2026-05|4-6 段 5-15 分钟/)).toBeNull()
    expect(screen.queryByText(/V2 SLOT/)).toBeNull()
    expect(screen.queryByText(/近期上线|敬请期待/)).toBeNull()

    cleanup()
  })
})

describe('FeedMetaBanners', () => {
  it('renders feed meta from an empty events response', () => {
    const response = { events: [], meta: { stale: true, partial_failures: ['x:bookmarks'] } }

    render(createElement(FeedMetaBanners, { meta: normalizeFeedMeta(response.meta) }))

    expect(response.events).toHaveLength(0)
    expect(screen.getByText('数据源同步异常: x:bookmarks')).toBeTruthy()
    expect(screen.getByText('数据超过新鲜度阈值, 可能过时')).toBeTruthy()

    cleanup()
  })

  it('surfaces partial failures and stale feed state', () => {
    render(createElement(FeedMetaBanners, { meta: { stale: true, partial_failures: ['jc:bookmarks', 'x:likes'] } }))

    expect(screen.getByText('数据源同步异常: jc:bookmarks, x:likes')).toBeTruthy()
    expect(screen.getByText('数据超过新鲜度阈值, 可能过时')).toBeTruthy()

    cleanup()
  })

  it('shows the configured freshness window when provided by feed meta', () => {
    render(createElement(FeedMetaBanners, { meta: { stale: true, partial_failures: [], freshness_hours: 1 } }))

    expect(screen.getByText('数据超过 1h 新鲜度阈值, 可能过时')).toBeTruthy()

    cleanup()
  })
})

describe('owner-only source action panels', () => {
  const member = makeAuthUser({ id: 'paopao', role: 'member' })
  const owner = makeAuthUser({ id: 'jc', display_name: 'JC', role: 'owner' })

  it('shows a disabled WeChat owner drop UI for members while keeping owner controls renderable', () => {
    let submits = 0
    const props = {
      draftUrl: '',
      onDraftUrlChange: () => {},
      onSubmit: () => { submits += 1 },
      submitting: false,
      requestError: null,
    }

    const { rerender } = render(createElement(WechatIngestPanel, { ...props, authUser: member }))
    expect(screen.getByText('粘贴微信公众号文章 URL')).toBeTruthy()
    expect(screen.getByPlaceholderText('owner 限定 · 联系 JC 开权限')).toBeTruthy()
    expect(screen.getByPlaceholderText('owner 限定 · 联系 JC 开权限')).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByTestId('wechat-ingest-panel'))
    expect(screen.getByText('此功能仅限 owner, 请联系 JC')).toBeTruthy()
    expect(submits).toBe(0)

    rerender(createElement(WechatIngestPanel, { ...props, authUser: owner }))
    expect(screen.getByText('粘贴微信公众号文章 URL')).toBeTruthy()
    expect(screen.getByPlaceholderText('https://mp.weixin.qq.com/s/...')).toHaveProperty('disabled', false)

    cleanup()
  })

  it('shows a disabled Zara refresh card for members while keeping owner controls renderable', () => {
    let refreshes = 0
    const props = {
      onRefresh: () => { refreshes += 1 },
      refreshing: false,
      requestError: null,
    }

    const { rerender } = render(createElement(ZaraRefreshPanel, { ...props, authUser: member }))
    expect(screen.getByText('Zara YouTube 精选刷新')).toBeTruthy()
    const memberButton = screen.getByRole('button', { name: 'owner 限定 · 联系 JC 手动刷新' })
    expect(memberButton).toHaveProperty('disabled', true)
    expect(memberButton.getAttribute('title')).toBe('owner 限定 · 联系 JC 手动刷新')
    fireEvent.click(screen.getByTestId('zara-refresh-panel'))
    expect(screen.getByText('此功能仅限 owner, 请联系 JC')).toBeTruthy()
    expect(refreshes).toBe(0)

    rerender(createElement(ZaraRefreshPanel, { ...props, authUser: owner }))
    expect(screen.getByText('Zara YouTube 精选刷新')).toBeTruthy()
    expect(screen.getByRole('button', { name: '抓取并刷新 Zara feed' })).toHaveProperty('disabled', false)

    cleanup()
  })
})

describe('FeedErrorBanners', () => {
  it('surfaces auth-check and feed-fetch failures without exposing raw errors', () => {
    render(createElement(FeedErrorBanners, { authCheckError: 'HTTP 500', feedFetchError: 'network down' }))

    expect(screen.getByText('身份核验失败, 请刷新页面或联系管理员 (飞书私聊 JC)')).toBeTruthy()
    expect(screen.getByText('数据加载失败, 请刷新页面或联系管理员 (飞书私聊 JC)')).toBeTruthy()
    expect(screen.queryByText('HTTP 500')).toBeNull()
    expect(screen.queryByText('network down')).toBeNull()

    cleanup()
  })
})

describe('mock feed loading', () => {
  it('keeps mock JSON behind a lazy dev fallback import', () => {
    const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ai-hotboard-screen.tsx')
    const source = fs.readFileSync(sourcePath, 'utf-8')

    expect(source).not.toContain("import hotboardData from './ai_hotboard_mock_events.json'")
    expect(source).not.toContain("await import('./ai_hotboard_mock_events.json')")
    expect(source).toContain('await import(/* @vite-ignore */ `./${DATA_SOURCE_LABEL}`)')
  })

  it('keeps source action panels before the global empty-state return', () => {
    const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ai-hotboard-screen.tsx')
    const source = fs.readFileSync(sourcePath, 'utf-8')
    const renderMainPanel = source.slice(
      source.indexOf('const renderMainPanel = () => {'),
      source.indexOf('  if (!authResolved)'),
    )

    const emptyReturnIndex = renderMainPanel.indexOf('if (isFeedPage(effectivePage) && timelineGroups.length === 0)')

    expect(renderMainPanel.indexOf("if (effectivePage === 'source-wechat')")).toBeLessThan(emptyReturnIndex)
    expect(renderMainPanel.indexOf("if (effectivePage === 'source-zara-youtube')")).toBeLessThan(emptyReturnIndex)
  })
})

describe('buildFeedStats', () => {
  const events: TimelineEvent[] = [
    makeTimelineEvent({ id: 'evt-1', engagement: { likes: 10, dislikes: 0, bookmarks: 5 } }),
    makeTimelineEvent({ id: 'evt-2', engagement: { likes: 20, dislikes: 0, bookmarks: 7 } }),
  ]

  it('falls back to event.engagement counts when no vote aggregate is known', () => {
    const stats = buildFeedStats(events)
    expect(stats.totalEvents).toBe(2)
    expect(stats.totalLikes).toBe(30)
    expect(stats.totalBookmarks).toBe(12)
  })

  it('reflects live vote aggregate on the LIKES / BOOKMARKS header stats', () => {
    const aggregate: VoteAggregateByEvent = {
      'evt-1': { like_count: 11, dislike_count: 0, bookmark_count: 6, my_vote: ['like', 'bookmark'] },
    }

    const stats = buildFeedStats(events, aggregate)

    expect(stats.totalLikes).toBe(11 + 20)
    expect(stats.totalBookmarks).toBe(6 + 7)
  })

  it('decrements header stats when an existing vote is toggled off', () => {
    const before: VoteAggregateByEvent = {
      'evt-1': { like_count: 11, dislike_count: 0, bookmark_count: 5, my_vote: ['like'] },
    }
    const after: VoteAggregateByEvent = {
      'evt-1': { like_count: 10, dislike_count: 0, bookmark_count: 5, my_vote: [] },
    }

    expect(buildFeedStats(events, before).totalLikes).toBe(11 + 20)
    expect(buildFeedStats(events, after).totalLikes).toBe(10 + 20)
  })
})
