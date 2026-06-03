import { describe, expect, it, vi } from 'vitest'
import {
  shouldEnableSearchData,
  shouldRenderSearchModal,
  unregisterServiceWorkers,
  wrapInlineScript,
} from './__root'

describe('root runtime guards', () => {
  it('wraps inline scripts in a top-level try/catch', () => {
    const wrapped = wrapInlineScript('window.answer = 42;')
    expect(wrapped).toContain('try {')
    expect(wrapped).toContain('window.answer = 42;')
    expect(wrapped).toContain("console.error('Inline bootstrap script failed'")
  })

  it('swallows getRegistrations rejections', async () => {
    const getRegistrations = vi.fn().mockRejectedValue(new Error('boom'))
    const unregister = vi.fn()

    await expect(
      unregisterServiceWorkers({
        serviceWorker: { getRegistrations },
        cachesApi: { keys: vi.fn().mockResolvedValue(['stale']), delete: unregister },
      }),
    ).resolves.toBeUndefined()

    expect(getRegistrations).toHaveBeenCalledTimes(1)
    expect(unregister).toHaveBeenCalledWith('stale')
  })
})

describe('root search modal gates', () => {
  it('lazy mounts the search modal only after the user opens it', () => {
    expect(
      shouldRenderSearchModal({
        isOpen: false,
        fullscreenExperience: false,
      }),
    ).toBe(false)
    expect(
      shouldRenderSearchModal({
        isOpen: true,
        fullscreenExperience: false,
      }),
    ).toBe(true)
  })

  it('keeps search data disabled until auth is verified', () => {
    expect(
      shouldEnableSearchData({
        authStatus: null,
        fullscreenExperience: false,
      }),
    ).toBe(false)
    expect(
      shouldEnableSearchData({
        authStatus: {
          authenticated: false,
          authRequired: true,
        },
        fullscreenExperience: false,
      }),
    ).toBe(false)
    expect(
      shouldEnableSearchData({
        authStatus: {
          authenticated: true,
          authRequired: true,
        },
        fullscreenExperience: false,
      }),
    ).toBe(true)
  })

  it('keeps the global search modal out of ai-hotboard fullscreen routes', () => {
    expect(
      shouldRenderSearchModal({
        isOpen: true,
        fullscreenExperience: true,
      }),
    ).toBe(false)
    expect(
      shouldEnableSearchData({
        authStatus: {
          authenticated: true,
          authRequired: true,
        },
        fullscreenExperience: true,
      }),
    ).toBe(false)
  })
})
