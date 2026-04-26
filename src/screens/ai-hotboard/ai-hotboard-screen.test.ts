// @vitest-environment jsdom
import { createElement } from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import {
  buildFeedStats,
  FeedErrorBanners,
  FeedMetaBanners,
  FeedTimeline,
  feedMatchesMode,
  JcHumanTalksComingSoonCard,
  normalizeFeedMeta,
  RECOMMEND_BANNER_CLASS,
  resolveFeedSourceForPage,
  SIDEBAR_NAV_SEQUENCE,
  SIGNAL_BADGE_CLASS,
  SOURCE_ITEMS,
  SOURCE_SUBMISSION_ITEMS,
  STRATEGY_ITERATION_ITEMS,
  STRATEGY_LINES,
  type TimelineEvent,
  type VoteAggregateByEvent,
} from './ai-hotboard-screen'

function makeTimelineEvent(overrides: Partial<TimelineEvent> & Pick<TimelineEvent, 'id'>): TimelineEvent {
  return {
    id: overrides.id,
    event_id: overrides.id,
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
    ...overrides,
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
      '精选',
      '全部 AI 动态',
      '热议帖 (估算)',
      '收藏',
      '信源',
      '信源提报',
      '精选策略',
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
    expect(screen.getByText(/第一批预计近期上线/)).toBeTruthy()
    expect(screen.getByText(/数段精华片段,时长不一/)).toBeTruthy()
    expect(screen.queryByText(/W19|2026-05|4-6 段 5-15 分钟/)).toBeNull()
    expect(screen.queryByText(/V2 SLOT/)).toBeNull()

    cleanup()
  })
})

describe('FeedMetaBanners', () => {
  it('renders feed meta from an empty events response', () => {
    const response = { events: [], meta: { stale: true, partial_failures: ['x:bookmarks'] } }

    render(createElement(FeedMetaBanners, { meta: normalizeFeedMeta(response.meta) }))

    expect(response.events).toHaveLength(0)
    expect(screen.getByText('🟡 部分信号源同步异常: x:bookmarks')).toBeTruthy()
    expect(screen.getByText('⏰ 数据不新鲜,距上次成功同步超过 24 小时')).toBeTruthy()

    cleanup()
  })

  it('surfaces partial failures and stale feed state', () => {
    render(createElement(FeedMetaBanners, { meta: { stale: true, partial_failures: ['jc:bookmarks', 'x:likes'] } }))

    expect(screen.getByText('🟡 部分信号源同步异常: jc:bookmarks, x:likes')).toBeTruthy()
    expect(screen.getByText('⏰ 数据不新鲜,距上次成功同步超过 24 小时')).toBeTruthy()

    cleanup()
  })
})

describe('FeedErrorBanners', () => {
  it('surfaces auth-check and feed-fetch failures without exposing raw errors', () => {
    render(createElement(FeedErrorBanners, { authCheckError: 'HTTP 500', feedFetchError: 'network down' }))

    expect(screen.getByText('身份核验失败 - 请刷新或联系 JC')).toBeTruthy()
    expect(screen.getByText('数据加载失败 - 请刷新或联系 JC')).toBeTruthy()
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
