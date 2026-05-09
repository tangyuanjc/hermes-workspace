import { describe, expect, it } from 'vitest'
import {
  getHotboardRouteChrome,
  HOTBOARD_ROUTE_CHROME,
  resolveHotboardPageFromSource,
  resolveSourceByHotboardPage,
  type AiHotboardPage,
} from './ai-hotboard-route-config'

describe('ai hotboard route config', () => {
  it('maps wechat source route to the dedicated source page', () => {
    expect(resolveHotboardPageFromSource('wechat')).toBe('source-wechat')
  })

  it('keeps source-wechat bound to wechat instead of all', () => {
    expect(resolveSourceByHotboardPage('source-wechat', 'all')).toBe('wechat')
  })

  it('maps zara youtube source route to the dedicated source page', () => {
    expect(resolveHotboardPageFromSource('zara-youtube')).toBe('source-zara-youtube')
    expect(resolveSourceByHotboardPage('source-zara-youtube', 'all')).toBe('zara-youtube')
  })

  it('requires every hotboard page to declare expanded or compact chrome explicitly', () => {
    const allPages: AiHotboardPage[] = [
      'featured',
      'view-all',
      'view-low-follower',
      'view-bookmarks',
      'source-x-bookmarks',
      'source-x-likes',
      'source-x-following',
      'source-x-for_you',
      'source-wechat',
      'source-jc-human-talks',
      'source-zara-youtube',
      'intake-hermes',
      'intake-xiaoj',
      'strategy-line',
      'iteration',
      'system',
      'user',
      'logout',
    ]

    expect(Object.keys(HOTBOARD_ROUTE_CHROME).sort()).toEqual([...allPages].sort())
    expect(getHotboardRouteChrome('view-all')).toBe('expanded')
    expect(getHotboardRouteChrome('source-x-bookmarks')).toBe('compact')
  })
})
