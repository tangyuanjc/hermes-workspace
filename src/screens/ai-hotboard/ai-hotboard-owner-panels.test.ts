// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WechatIngestPanel, ZaraRefreshPanel } from './ai-hotboard-screen'
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
