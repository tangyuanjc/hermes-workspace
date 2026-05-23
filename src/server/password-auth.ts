import { timingSafeEqual } from 'node:crypto'

export type PasswordUserRole = 'owner' | 'member'

export type PasswordUserRecord = {
  username: string
  displayName: string
  role: PasswordUserRole
}

// 8-person internal pilot whitelist. The login identifier is the short
// English username (not an email) so we don't need real mailbox provisioning.
// Per-user passwords come from env vars `PASSWORD_<USERNAME>` (uppercase).
// Example: PASSWORD_JC=xxxxxx PASSWORD_PAOPAO=xxxxxx ...
const PASSWORD_WHITELIST: ReadonlyArray<PasswordUserRecord> = [
  { username: 'jc', displayName: 'JC', role: 'owner' },
  { username: 'paopao', displayName: '泡泡', role: 'member' },
  { username: 'pipi', displayName: '皮皮', role: 'member' },
  { username: 'naisi', displayName: '奶思', role: 'member' },
  { username: 'huangning', displayName: '黄宁', role: 'member' },
  { username: 'fangfang', displayName: '芳芳', role: 'member' },
  { username: 'xiaolong', displayName: '小龙', role: 'member' },
  { username: 'xinxin', displayName: '欣欣', role: 'member' },
]

export function getPasswordWhitelist(): ReadonlyArray<PasswordUserRecord> {
  return PASSWORD_WHITELIST
}

export function isPasswordAuthConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return PASSWORD_WHITELIST.some((user) =>
    Boolean(env[envKeyFor(user)]?.trim()),
  )
}

export function resolvePasswordUser(
  username: string,
): PasswordUserRecord | null {
  const normalized = username.trim().toLowerCase()
  if (!normalized) return null
  return PASSWORD_WHITELIST.find((u) => u.username === normalized) ?? null
}

function envKeyFor(user: PasswordUserRecord): string {
  return `PASSWORD_${user.username.toUpperCase()}`
}

export function readExpectedPassword(
  user: PasswordUserRecord,
  env: Record<string, string | undefined> = process.env,
): { password: string; source: 'env' | 'dev-fallback' } | null {
  const envValue = env[envKeyFor(user)]?.trim()
  if (envValue) return { password: envValue, source: 'env' }
  // Dev-mode fallback so the app is usable before JC sets env vars.
  // In production we refuse to authenticate without a configured password.
  if (env.NODE_ENV === 'production') return null
  return { password: user.username, source: 'dev-fallback' }
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8')
  const bBuf = Buffer.from(b, 'utf8')
  if (aBuf.length !== bBuf.length) {
    // Still run a constant-time compare against same-length bytes to avoid
    // early-exit timing leaks, then return false regardless.
    const filler = Buffer.alloc(aBuf.length)
    try {
      timingSafeEqual(aBuf, filler)
    } catch {
      // ignore
    }
    return false
  }
  try {
    return timingSafeEqual(aBuf, bBuf)
  } catch {
    return false
  }
}

export type PasswordAuthResult =
  | { ok: true; user: PasswordUserRecord; source: 'env' | 'dev-fallback' }
  | {
      ok: false
      reason: 'unknown_user' | 'no_password_configured' | 'wrong_password'
    }

export function authenticatePassword(
  username: string,
  password: string,
  env: Record<string, string | undefined> = process.env,
): PasswordAuthResult {
  const user = resolvePasswordUser(username)
  if (!user) return { ok: false, reason: 'unknown_user' }
  const expected = readExpectedPassword(user, env)
  if (!expected) return { ok: false, reason: 'no_password_configured' }
  if (!timingSafeStringEqual(password, expected.password)) {
    return { ok: false, reason: 'wrong_password' }
  }
  return { ok: true, user, source: expected.source }
}

export function passwordUserToUpsertInput(user: PasswordUserRecord): {
  feishuOpenId: string
  displayName: string
  role: PasswordUserRole
} {
  // We re-use the existing feishu_open_id column as a generic provider id so
  // we don't need a schema change. The `pwd:` prefix disambiguates from
  // feishu / email records.
  return {
    feishuOpenId: `pwd:${user.username}`,
    displayName: user.displayName,
    role: user.role,
  }
}
