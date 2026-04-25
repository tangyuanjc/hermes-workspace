// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import {
  buildFeedStats,
  FeedTimeline,
  RECOMMEND_BANNER_CLASS,
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
      '低粉爆文',
      '收藏',
      '信源',
      '信源提报',
      '精选策略',
      '策略迭代',
      '系统',
      '用户',
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
