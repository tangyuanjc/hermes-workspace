import { toSupportedHotboardSource } from './ai-hotboard-feed-adapter'

export type SourcePageKey =
  | 'source-x-bookmarks'
  | 'source-x-likes'
  | 'source-x-following'
  | 'source-x-for_you'
  | 'source-wechat'
  | 'source-jc-human-talks'
  | 'source-zara-youtube'

export type AiHotboardPage =
  | 'featured'
  | 'view-all'
  | 'view-low-follower'
  | 'view-bookmarks'
  | SourcePageKey
  | 'intake-hermes'
  | 'intake-xiaoj'
  | 'strategy-line'
  | 'iteration'
  | 'system'
  | 'user'
  | 'logout'

export type HotboardRouteChrome = 'expanded' | 'compact'

export const HOTBOARD_ROUTE_CHROME = {
  featured: 'compact',
  'view-all': 'expanded',
  'view-low-follower': 'expanded',
  'view-bookmarks': 'compact',
  'source-x-bookmarks': 'compact',
  'source-x-likes': 'compact',
  'source-x-following': 'compact',
  'source-x-for_you': 'compact',
  'source-wechat': 'compact',
  'source-jc-human-talks': 'compact',
  'source-zara-youtube': 'compact',
  'intake-hermes': 'compact',
  'intake-xiaoj': 'compact',
  'strategy-line': 'compact',
  iteration: 'compact',
  system: 'compact',
  user: 'compact',
  logout: 'compact',
} satisfies Record<AiHotboardPage, HotboardRouteChrome>

export function getHotboardRouteChrome(page: AiHotboardPage): HotboardRouteChrome {
  return HOTBOARD_ROUTE_CHROME[page]
}

export function normalizeHotboardPage(page?: AiHotboardPage): AiHotboardPage {
  return page ?? 'featured'
}

export function resolveHotboardPageFromSource(source: string): AiHotboardPage {
  if (source === 'x-bookmarks') return 'source-x-bookmarks'
  if (source === 'x-likes') return 'source-x-likes'
  if (source === 'x-following') return 'source-x-following'
  if (source === 'x-for_you') return 'source-x-for_you'
  if (source === 'wechat') return 'source-wechat'
  if (source === 'jc-human-talks') return 'source-jc-human-talks'
  if (source === 'zara-youtube') return 'source-zara-youtube'
  return 'featured'
}

export function resolveSourceByHotboardPage(page: AiHotboardPage, fallbackSource: string) {
  if (page === 'source-x-bookmarks') return 'x-bookmarks'
  if (page === 'source-x-likes') return 'x-likes'
  if (page === 'source-x-following') return 'x-following'
  if (page === 'source-x-for_you') return 'x-for_you'
  if (page === 'source-wechat') return 'wechat'
  if (page === 'source-zara-youtube') return 'zara-youtube'

  if (
    page === 'source-jc-human-talks' ||
    page === 'featured' ||
    page === 'view-all' ||
    page === 'view-low-follower' ||
    page === 'view-bookmarks' ||
    page === 'iteration' ||
    page === 'system' ||
    page === 'user' ||
    page === 'logout' ||
    page === 'intake-hermes' ||
    page === 'intake-xiaoj' ||
    page === 'strategy-line'
  ) {
    return 'all'
  }

  return toSupportedHotboardSource(fallbackSource)
}
