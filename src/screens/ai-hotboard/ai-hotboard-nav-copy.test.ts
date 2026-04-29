// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { FeedErrorBanners, SIDEBAR_NAV_SEQUENCE } from './ai-hotboard-screen'

afterEach(() => {
  cleanup()
})

describe('ai-hotboard nav and support copy', () => {
  it('keeps the root nav aligned to the all-feed route instead of curated copy', () => {
    expect(SIDEBAR_NAV_SEQUENCE[0]).toBe('全部 AI 动态')
    expect(SIDEBAR_NAV_SEQUENCE).not.toContain('精选')
    expect(SIDEBAR_NAV_SEQUENCE).toContain('策略线路')
  })

  it('names the concrete Feishu support contact in generic failure banners', () => {
    render(createElement(FeedErrorBanners, { authCheckError: 'HTTP 500', feedFetchError: 'network down' }))

    expect(screen.getByText('身份核验失败, 请刷新页面或联系管理员 (飞书私聊 JC)')).toBeTruthy()
    expect(screen.getByText('数据加载失败, 请刷新页面或联系管理员 (飞书私聊 JC)')).toBeTruthy()
  })
})
