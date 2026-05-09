import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchCachedAuthSnapshot,
  resetAiHotboardAuthCacheForTests,
} from './ai-hotboard-auth'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
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
    vi.useFakeTimers()
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
})
