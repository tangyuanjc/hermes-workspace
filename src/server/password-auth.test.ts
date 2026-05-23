import { describe, expect, it } from 'vitest'
import {
  authenticatePassword,
  getPasswordWhitelist,
  isPasswordAuthConfigured,
  passwordUserToUpsertInput,
  readExpectedPassword,
  resolvePasswordUser,
} from './password-auth'

describe('resolvePasswordUser', () => {
  it('resolves whitelisted usernames case-insensitively', () => {
    expect(resolvePasswordUser('jc')?.role).toBe('owner')
    expect(resolvePasswordUser('  JC  ')?.role).toBe('owner')
    expect(resolvePasswordUser('PaoPao')?.displayName).toBe('泡泡')
  })

  it('returns null for unknown or empty usernames', () => {
    expect(resolvePasswordUser('')).toBeNull()
    expect(resolvePasswordUser('   ')).toBeNull()
    expect(resolvePasswordUser('nobody')).toBeNull()
  })

  it('covers the full 8-person pilot whitelist', () => {
    const usernames = getPasswordWhitelist()
      .map((u) => u.username)
      .sort()
    expect(usernames).toEqual(
      [
        'fangfang',
        'huangning',
        'jc',
        'naisi',
        'paopao',
        'pipi',
        'xiaolong',
        'xinxin',
      ].sort(),
    )
  })
})

describe('readExpectedPassword', () => {
  const jc = resolvePasswordUser('jc')!

  it('prefers env-configured passwords', () => {
    const result = readExpectedPassword(jc, { PASSWORD_JC: 'secret-abc' })
    expect(result).toEqual({ password: 'secret-abc', source: 'env' })
  })

  it('falls back to the username as password outside production', () => {
    const result = readExpectedPassword(jc, { NODE_ENV: 'development' })
    expect(result).toEqual({ password: 'jc', source: 'dev-fallback' })
  })

  it('refuses fallback in production without explicit env config', () => {
    const result = readExpectedPassword(jc, { NODE_ENV: 'production' })
    expect(result).toBeNull()
  })
})

describe('isPasswordAuthConfigured', () => {
  it('detects PASSWORD_* env configuration for the pilot whitelist', () => {
    expect(isPasswordAuthConfigured({ PASSWORD_JC: 'secret-abc' })).toBe(true)
    expect(
      isPasswordAuthConfigured({ PASSWORD_PAOPAO: '  paopao-secret  ' }),
    ).toBe(true)
    expect(isPasswordAuthConfigured({ HERMES_PASSWORD: 'legacy-only' })).toBe(
      false,
    )
    expect(isPasswordAuthConfigured({ PASSWORD_JC: '   ' })).toBe(false)
  })
})

describe('authenticatePassword', () => {
  it('succeeds for matching env-configured password', () => {
    const result = authenticatePassword('jc', 'secret-abc', {
      PASSWORD_JC: 'secret-abc',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.user.username).toBe('jc')
      expect(result.source).toBe('env')
    }
  })

  it('rejects wrong password without leaking which account exists', () => {
    const r1 = authenticatePassword('jc', 'not-the-password', {
      PASSWORD_JC: 'secret-abc',
    })
    const r2 = authenticatePassword('nobody-like-this', 'anything', {
      PASSWORD_JC: 'secret-abc',
    })
    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(false)
    if (!r1.ok) expect(r1.reason).toBe('wrong_password')
    if (!r2.ok) expect(r2.reason).toBe('unknown_user')
  })

  it('refuses auth in production when no env password is configured', () => {
    const result = authenticatePassword('jc', 'jc', { NODE_ENV: 'production' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no_password_configured')
  })

  it('dev-mode fallback: username doubles as password', () => {
    const result = authenticatePassword('paopao', 'paopao', {
      NODE_ENV: 'development',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.source).toBe('dev-fallback')
  })
})

describe('passwordUserToUpsertInput', () => {
  it('maps username to a pwd-prefixed provider id to avoid clashing with feishu rows', () => {
    const jc = resolvePasswordUser('jc')!
    expect(passwordUserToUpsertInput(jc)).toEqual({
      feishuOpenId: 'pwd:jc',
      displayName: 'JC',
      role: 'owner',
    })
  })
})
