import { describe, expect, it } from 'vitest'
import {
  DESKTOP_SIDEBAR_BACKDROP_CLASS,
  isFullscreenExperienceRoute,
  shouldLoadWorkspaceData,
  shouldSuppressWorkspaceOverlays,
} from './workspace-shell'

describe('workspace shell sidebar backdrop', () => {
  it('only spans the desktop sidebar width, not the full viewport', () => {
    expect(DESKTOP_SIDEBAR_BACKDROP_CLASS).toContain('w-[300px]')
    expect(DESKTOP_SIDEBAR_BACKDROP_CLASS).not.toContain('inset-0')
  })
})

describe('isFullscreenExperienceRoute', () => {
  it('matches every /ai-hotboard/* path so the Hermes chat panel stays hidden there', () => {
    expect(isFullscreenExperienceRoute('/ai-hotboard')).toBe(true)
    expect(isFullscreenExperienceRoute('/ai-hotboard/view/all')).toBe(true)
    expect(isFullscreenExperienceRoute('/ai-hotboard/source/x-bookmarks')).toBe(true)
    expect(isFullscreenExperienceRoute('/ai-hotboard/strategy/line-a')).toBe(true)
  })

  it('does not match unrelated routes where the chat panel is still the primary chat UI', () => {
    expect(isFullscreenExperienceRoute('/')).toBe(false)
    expect(isFullscreenExperienceRoute('/dashboard')).toBe(false)
    expect(isFullscreenExperienceRoute('/chat/main')).toBe(false)
    expect(isFullscreenExperienceRoute('/skills')).toBe(false)
  })
})

describe('shouldLoadWorkspaceData', () => {
  it('waits for auth-check before starting workspace pollers', () => {
    expect(
      shouldLoadWorkspaceData({
        authChecked: false,
        authenticated: true,
        fullscreenExperience: false,
      }),
    ).toBe(false)
  })

  it('does not start workspace pollers for unauthenticated users or fullscreen experiences', () => {
    expect(
      shouldLoadWorkspaceData({
        authChecked: true,
        authenticated: false,
        fullscreenExperience: false,
      }),
    ).toBe(false)
    expect(
      shouldLoadWorkspaceData({
        authChecked: true,
        authenticated: true,
        fullscreenExperience: true,
      }),
    ).toBe(false)
  })

  it('starts workspace pollers only after an authenticated non-fullscreen route is ready', () => {
    expect(
      shouldLoadWorkspaceData({
        authChecked: true,
        authenticated: true,
        fullscreenExperience: false,
      }),
    ).toBe(true)
  })
})

describe('shouldSuppressWorkspaceOverlays', () => {
  it('suppresses Hermes workspace overlays on ai-hotboard login/fullscreen routes', () => {
    expect(shouldSuppressWorkspaceOverlays('/ai-hotboard')).toBe(true)
    expect(shouldSuppressWorkspaceOverlays('/ai-hotboard/source/x-bookmarks')).toBe(true)
  })
})
