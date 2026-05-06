// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  getVisibleSystemNavItems,
  IntakePanel,
  resolveVisibleSourceLabel,
  shouldShowExpandedFeedChrome,
  WechatIngestPanel,
  ZaraRefreshPanel,
} from './ai-hotboard-screen'
import type { AuthUser } from '@/lib/hermes-auth'

afterEach(() => {
  cleanup()
})

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

describe('ai-hotboard member owner-card explainers', () => {
  const member = makeAuthUser({ id: 'member', role: 'member' })
  const owner = makeAuthUser({ id: 'owner', role: 'owner' })

  it('hides backend nav items from members', () => {
    expect(getVisibleSystemNavItems(member).map((item) => item.label)).toEqual([])
    expect(getVisibleSystemNavItems(owner).map((item) => item.label)).toEqual(['系统', '用户', '信源健康', '退出'])
  })

  it('maps internal source labels for members while preserving owner raw labels', () => {
    expect(resolveVisibleSourceLabel('x_signal_sync_latest.json', member)).toBe('X 实时同步')
    expect(resolveVisibleSourceLabel('hotboard-wechat.sqlite', member)).toBe('公众号手动池')
    expect(resolveVisibleSourceLabel('~/.org/shared-memory/business-glossary.md', member)).toBe('M2 业务主线表')
    expect(resolveVisibleSourceLabel('/Users/tangyuanjc/private/feed.json', member)).toBe('AI 热点看板信号池')
    expect(resolveVisibleSourceLabel('hotboard-wechat.sqlite', owner)).toBe('hotboard-wechat.sqlite')
  })

  it('keeps expanded KPI chrome only on all and low-follower views', () => {
    expect(shouldShowExpandedFeedChrome('view-all')).toBe(true)
    expect(shouldShowExpandedFeedChrome('view-low-follower')).toBe(true)
    expect(shouldShowExpandedFeedChrome('view-bookmarks')).toBe(false)
    expect(shouldShowExpandedFeedChrome('source-x-bookmarks')).toBe(false)
    expect(shouldShowExpandedFeedChrome('system')).toBe(false)
  })

  it('renders intake as read-only for members without a create affordance', () => {
    render(createElement(IntakePanel, {
      authorAgent: 'hermes',
      title: '爱马仕战略发现',
      authUser: member,
      items: [],
      selectedItemId: null,
      onSelectItem: () => {},
      draft: { title: '', body: '', tagsText: '' },
      onDraftChange: () => {},
      onSubmit: () => {},
      submitting: false,
      requestError: null,
      listLoading: false,
      listError: null,
    }))

    expect(screen.getByText('只读列表')).toBeTruthy()
    expect(screen.getByRole('link', { name: '联系 JC 申请 owner 权限' })).toBeTruthy()
    expect(screen.queryByText('新增提报')).toBeNull()
    expect(screen.queryByRole('button', { name: '提交提报' })).toBeNull()
  })

  it('renders the WeChat ingest card disabled for members without firing submit', () => {
    let submits = 0
    render(createElement(WechatIngestPanel, {
      authUser: member,
      draftUrl: '',
      onDraftUrlChange: () => {},
      onSubmit: () => { submits += 1 },
      submitting: false,
      requestError: null,
    }))

    expect(screen.getByPlaceholderText('owner 限定 · 联系 JC 开权限')).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByTestId('wechat-ingest-panel'))
    expect(screen.getByText('此功能仅限 owner, 请联系 JC')).toBeTruthy()
    expect(submits).toBe(0)
  })

  it('renders the Zara refresh card disabled for members without firing refresh', () => {
    let refreshes = 0
    render(createElement(ZaraRefreshPanel, {
      authUser: member,
      onRefresh: () => { refreshes += 1 },
      refreshing: false,
      requestError: null,
    }))

    const button = screen.getByRole('button', { name: 'owner 限定 · 联系 JC 手动刷新' })
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByTestId('zara-refresh-panel'))
    expect(screen.getByText('此功能仅限 owner, 请联系 JC')).toBeTruthy()
    expect(refreshes).toBe(0)
  })
})
