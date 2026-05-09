export type NormalizedRole = 'owner' | 'member'

export function normalizeRole(role: unknown): NormalizedRole | null {
  if (role === 'owner' || role === 'member') return role
  return null
}
