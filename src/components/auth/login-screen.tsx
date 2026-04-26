import { type CSSProperties, useMemo, useState } from 'react'

const PASSWORD_LOGIN_URL = '/api/auth/password'
const EMAIL_MAGIC_LINK_START_URL = '/api/auth/email'

type LoginMode = 'password' | 'magic-link'

const EDITORIAL_DISPLAY_STYLE = {
  fontFamily: '"EB Garamond", "Times New Roman", Georgia, serif',
} satisfies CSSProperties

const EDITORIAL_MONO_STYLE = {
  fontFamily: '"JetBrains Mono", "SFMono-Regular", ui-monospace, monospace',
} satisfies CSSProperties

const LOGIN_CARD_STYLE = {
  backgroundImage:
    'radial-gradient(circle at top left, rgba(103, 232, 249, 0.10), transparent 34%), radial-gradient(circle at bottom right, rgba(251, 191, 36, 0.06), transparent 28%), linear-gradient(180deg, rgba(15, 23, 42, 0.86) 0%, rgba(2, 6, 23, 0.82) 100%)',
} satisfies CSSProperties

const LOGIN_INPUT_CLASS =
  'w-full rounded-[18px] border border-slate-300/20 bg-slate-950/75 px-4 py-3 text-sm text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] outline-none transition-all placeholder:text-slate-500 focus:border-cyan-300/40 focus:bg-slate-950/90 focus:shadow-[0_0_0_1px_rgba(103,232,249,0.18)]'

const LOGIN_BUTTON_CLASS =
  'inline-flex w-full items-center justify-center rounded-[18px] border border-cyan-300/35 bg-cyan-400 px-4 py-3 text-sm font-semibold text-slate-950 shadow-[0_18px_40px_rgba(8,145,178,0.22)] transition-all duration-200 hover:-translate-y-px hover:border-cyan-100/70 hover:bg-cyan-300 focus:outline-none focus:ring-2 focus:ring-cyan-300/40 disabled:cursor-not-allowed disabled:opacity-60'

const LOGIN_TOAST_CLASS =
  'rounded-[18px] border bg-slate-950/70 px-4 py-3 text-sm shadow-[0_18px_40px_rgba(2,6,23,0.26),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-md'

function readAuthErrorFromUrl() {
  if (typeof window === 'undefined') return ''
  const params = new URLSearchParams(window.location.search)
  return String(params.get('auth_error') || '').trim()
}

export function LoginScreen() {
  const authError = useMemo(() => readAuthErrorFromUrl(), [])
  const [mode, setMode] = useState<LoginMode>('password')

  // Password form state
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  // Email magic-link state
  const [email, setEmail] = useState('')

  // Shared request state
  const [submitting, setSubmitting] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [requestSuccess, setRequestSuccess] = useState<string | null>(null)

  function clearMessages() {
    if (requestError) setRequestError(null)
    if (requestSuccess) setRequestSuccess(null)
  }

  async function submitPasswordLogin() {
    const normalizedUser = username.trim().toLowerCase()
    const pass = password
    if (!normalizedUser || !pass) {
      setRequestError('请输入用户名和密码')
      return
    }
    setSubmitting(true)
    setRequestError(null)
    setRequestSuccess(null)
    try {
      const response = await fetch(PASSWORD_LOGIN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: normalizedUser, password: pass }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        user?: { display_name?: string }
      }
      if (!response.ok || !payload.ok) {
        setRequestError(payload.error || `登录失败（HTTP ${response.status}）`)
        return
      }
      // Session cookie is set by the server. Reload to enter the authed shell.
      if (typeof window !== 'undefined') {
        window.location.href = '/ai-hotboard'
      }
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : '登录失败，请稍后再试',
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function submitEmailMagicLink() {
    const normalized = email.trim().toLowerCase()
    if (!normalized) {
      setRequestError('请输入邮箱')
      return
    }
    setSubmitting(true)
    setRequestError(null)
    setRequestSuccess(null)
    try {
      const response = await fetch(EMAIL_MAGIC_LINK_START_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalized }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
      }
      if (!response.ok || !payload.ok) {
        setRequestError(payload.error || `发送失败（HTTP ${response.status}）`)
        return
      }
      setRequestSuccess(
        `已发邮件到 ${normalized}，请点击链接登录（15 分钟有效）`,
      )
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : '发送失败，请稍后再试',
      )
    } finally {
      setSubmitting(false)
    }
  }

  const errorText =
    authError.length > 0 ? authError : '未授权访问 ai-hotboard，请联系 JC'

  const isPassword = mode === 'password'

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 px-4 py-10 text-slate-100">
      <div className="w-full max-w-md">
        <div
          className="rounded-[28px] border border-white/10 bg-slate-900/60 px-8 py-10 shadow-[0_28px_80px_rgba(2,6,23,0.58),inset_0_1px_0_rgba(255,255,255,0.04)] ring-1 ring-cyan-300/15 backdrop-blur-md"
          style={LOGIN_CARD_STYLE}
        >
          <div className="mb-8 flex justify-center">
            <div className="flex items-center gap-3">
              <svg
                width="32"
                height="32"
                viewBox="0 0 100 100"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="text-cyan-300 drop-shadow-[0_0_18px_rgba(103,232,249,0.18)]"
              >
                <path
                  d="M50 10 L90 30 L90 70 L50 90 L10 70 L10 30 Z"
                  fill="currentColor"
                  opacity="0.15"
                />
                <path
                  d="M50 25 L75 38 L75 62 L50 75 L25 62 L25 38 Z"
                  fill="currentColor"
                  opacity="0.3"
                />
                <circle cx="50" cy="50" r="15" fill="currentColor" />
              </svg>
              <h1
                className="text-[2rem] leading-none tracking-tight text-cyan-100"
                style={EDITORIAL_DISPLAY_STYLE}
              >
                AI Hotboard
              </h1>
            </div>
          </div>

          <h2
            className="mb-2 text-center text-[11px] uppercase tracking-[0.28em] text-cyan-300/70"
            style={EDITORIAL_MONO_STYLE}
          >
            {isPassword ? '账号登录' : '邮箱登录'}
          </h2>
          <p className="mb-6 text-center text-sm leading-6 text-slate-300">
            {isPassword
              ? '使用 JC 分配的用户名和密码'
              : '仅白名单员工可访问（Magic Link，15 分钟有效）'}
          </p>

          <div className="space-y-4">
            {authError ? (
              <div
                className={`${LOGIN_TOAST_CLASS} border-red-300/20 text-red-300 ring-1 ring-red-300/10`}
                role="alert"
                aria-live="polite"
              >
                {errorText}
              </div>
            ) : null}

            {isPassword ? (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void submitPasswordLogin()
                }}
              >
                <input
                  type="text"
                  value={username}
                  onChange={(event) => {
                    setUsername(event.target.value)
                    clearMessages()
                  }}
                  placeholder="用户名（例如 paopao）"
                  aria-label="用户名"
                  className={LOGIN_INPUT_CLASS}
                  autoComplete="username"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <input
                  type="password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value)
                    clearMessages()
                  }}
                  placeholder="密码"
                  aria-label="密码"
                  className={LOGIN_INPUT_CLASS}
                  autoComplete="current-password"
                />
                <button
                  type="submit"
                  aria-label="使用用户名和密码登录"
                  disabled={submitting}
                  className={LOGIN_BUTTON_CLASS}
                >
                  {submitting ? '登录中...' : '登录'}
                </button>
              </form>
            ) : (
              <div className="space-y-2">
                <input
                  type="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value)
                    clearMessages()
                  }}
                  placeholder="you@example.com"
                  aria-label="邮箱"
                  className={LOGIN_INPUT_CLASS}
                  autoComplete="email"
                />
                <button
                  type="button"
                  aria-label="发送邮箱登录链接"
                  onClick={() => {
                    void submitEmailMagicLink()
                  }}
                  disabled={submitting}
                  className={LOGIN_BUTTON_CLASS}
                >
                  {submitting ? '发送中...' : '发送登录链接'}
                </button>
              </div>
            )}

            {requestError ? (
              <div
                className={`${LOGIN_TOAST_CLASS} border-red-300/20 text-red-300 ring-1 ring-red-300/10`}
                role="alert"
                aria-live="polite"
              >
                {requestError}
              </div>
            ) : null}

            {requestSuccess ? (
              <div
                className={`${LOGIN_TOAST_CLASS} border-emerald-300/20 text-emerald-300 ring-1 ring-emerald-300/10`}
                role="alert"
                aria-live="polite"
              >
                {requestSuccess}
              </div>
            ) : null}

            <div className="pt-2 text-center">
              <button
                type="button"
                onClick={() => {
                  setMode(isPassword ? 'magic-link' : 'password')
                  clearMessages()
                }}
                className="text-xs text-cyan-300/50 underline-offset-4 transition-colors hover:text-cyan-200 hover:underline"
              >
                {isPassword ? '改用邮箱 Magic Link 登录' : '改用账号密码登录'}
              </button>
            </div>

            <p className="text-center text-xs text-cyan-300/50 underline-offset-4">
              账号未配置或忘记密码？请联系 JC
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
