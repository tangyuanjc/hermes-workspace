import { describe, expect, it } from 'vitest'
import { DEFAULT_LOCALE, translate } from './i18n'

describe('i18n translation helpers', () => {
  it('keeps English as the deterministic hydration default', () => {
    expect(DEFAULT_LOCALE).toBe('en')
    expect(translate('nav.dashboard', DEFAULT_LOCALE)).toBe('Dashboard')
  })

  it('can translate client locales after hydration', () => {
    expect(translate('nav.dashboard', 'zh')).toBe('仪表板')
    expect(translate('nav.chat', 'zh')).toBe('聊天')
  })
})
