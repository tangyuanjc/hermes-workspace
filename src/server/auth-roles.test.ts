import { describe, expect, it } from 'vitest'
import { normalizeRole } from './auth-roles'

describe('auth role normalization', () => {
  it('fails closed for unknown or missing roles', () => {
    expect(normalizeRole('owner')).toBe('owner')
    expect(normalizeRole('member')).toBe('member')
    expect(normalizeRole('OWNER')).toBeNull()
    expect(normalizeRole('admin')).toBeNull()
    expect(normalizeRole(null)).toBeNull()
    expect(normalizeRole(undefined)).toBeNull()
  })
})
