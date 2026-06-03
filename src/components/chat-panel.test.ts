import { describe, expect, it } from 'vitest'
import { shouldLoadChatPanelSessions } from './chat-panel'

describe('chat panel auth gate', () => {
  it('loads sessions only after auth is verified and the panel is open', () => {
    expect(
      shouldLoadChatPanelSessions({
        isAuthenticated: false,
        isOpen: false,
      }),
    ).toBe(false)
    expect(
      shouldLoadChatPanelSessions({
        isAuthenticated: false,
        isOpen: true,
      }),
    ).toBe(false)
    expect(
      shouldLoadChatPanelSessions({
        isAuthenticated: true,
        isOpen: false,
      }),
    ).toBe(false)
    expect(
      shouldLoadChatPanelSessions({
        isAuthenticated: true,
        isOpen: true,
      }),
    ).toBe(true)
  })
})
