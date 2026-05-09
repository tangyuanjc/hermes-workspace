// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchCachedAuthSnapshot,
  redirectToAiHotboardLogin,
  resetAiHotboardAuthCacheForTests,
  startAiHotboardAuthRevalidationTimer,
} from './ai-hotboard-auth'

const originalAuthRevalidateIntervalMs = import.meta.env.HOTBOARD_AUTH_REVALIDATE_INTERVAL_MS

function useAuthFakeTimers() {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (originalAuthRevalidateIntervalMs === undefined) {
    delete import.meta.env.HOTBOARD_AUTH_REVALIDATE_INTERVAL_MS
  } else {
    import.meta.env.HOTBOARD_AUTH_REVALIDATE_INTERVAL_MS = originalAuthRevalidateIntervalMs
  }
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  resetAiHotboardAuthCacheForTests()
})

function authResponse(role: 'owner' | 'member', id: string = role) {
  return new Response(JSON.stringify({
    authenticated: true,
    authRequired: true,
    session_version: `${id}:${role}`,
    user: {
      id,
      feishu_open_id: id,
      feishu_union_id: null,
      email: null,
      display_name: role === 'owner' ? 'JC' : '泡泡',
      role,
    },
  }))
}

describe('ai-hotboard auth cache', () => {
  it('fails closed when /api/auth-check returns an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('broken', { status: 500 })))

    const snapshot = await fetchCachedAuthSnapshot({ force: true })

    expect(snapshot.authCheckError).toContain('HTTP 500')
    expect(snapshot.authUser).toBeNull()
    expect(snapshot.authRequired).toBe(true)
  })

  it('re-fetches auth after the cache ttl expires', async () => {
    useAuthFakeTimers()
    vi.setSystemTime(new Date('2026-05-06T10:00:00.000Z'))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(authResponse('owner', 'jc'))
      .mockResolvedValueOnce(authResponse('member', 'paopao'))
    vi.stubGlobal('fetch', fetchMock)

    const first = await fetchCachedAuthSnapshot()
    expect(first.authUser?.role).toBe('owner')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const cached = await fetchCachedAuthSnapshot()
    expect(cached.authUser?.role).toBe('owner')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60_001)
    const refreshed = await fetchCachedAuthSnapshot()
    expect(refreshed.authUser?.role).toBe('member')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('auto revalidates active tabs on the default interval', () => {
    useAuthFakeTimers()
    const refreshAuth = vi.fn()

    const cleanupTimer = startAiHotboardAuthRevalidationTimer({ refreshAuth, documentRef: document })

    vi.advanceTimersByTime(59_999)
    expect(refreshAuth).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(refreshAuth).toHaveBeenCalledTimes(1)

    cleanupTimer()
  })

  it('pauses auth revalidation while hidden and revalidates immediately when visible', () => {
    useAuthFakeTimers()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const refreshAuth = vi.fn()

    const cleanupTimer = startAiHotboardAuthRevalidationTimer({ refreshAuth, documentRef: document })

    vi.advanceTimersByTime(5 * 60_000)
    expect(refreshAuth).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))

    expect(refreshAuth).toHaveBeenCalledTimes(1)

    cleanupTimer()
  })

  it('stops the timer and returns to the login route after BroadcastChannel logout cleanup', () => {
    useAuthFakeTimers()
    window.history.pushState(null, '', '/ai-hotboard/source/x-bookmarks')
    const refreshAuth = vi.fn()

    const cleanupTimer = startAiHotboardAuthRevalidationTimer({ refreshAuth, documentRef: document })

    cleanupTimer()
    redirectToAiHotboardLogin()

    expect(window.location.pathname).toBe('/ai-hotboard')

    vi.advanceTimersByTime(60_000)
    expect(refreshAuth).not.toHaveBeenCalled()
  })

  it('uses HOTBOARD_AUTH_REVALIDATE_INTERVAL_MS for the timer interval', () => {
    useAuthFakeTimers()
    import.meta.env.HOTBOARD_AUTH_REVALIDATE_INTERVAL_MS = '10000'
    const refreshAuth = vi.fn()

    const cleanupTimer = startAiHotboardAuthRevalidationTimer({ refreshAuth, documentRef: document })

    vi.advanceTimersByTime(9_999)
    expect(refreshAuth).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(refreshAuth).toHaveBeenCalledTimes(1)

    cleanupTimer()
  })
})
