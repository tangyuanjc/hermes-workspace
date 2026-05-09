import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { fetchHermesAuthStatus, type AuthUser } from '@/lib/hermes-auth'

type AiHotboardAuthSnapshot = {
  authUser: AuthUser | null
  authResolved: boolean
  authRequired: boolean
  authCheckError: string | null
  sessionVersion: string
}

type AiHotboardAuthContextValue = AiHotboardAuthSnapshot & {
  refreshAuth: () => Promise<void>
}

const UNRESOLVED_AUTH_SNAPSHOT: AiHotboardAuthSnapshot = {
  authUser: null,
  authResolved: false,
  authRequired: false,
  authCheckError: null,
  sessionVersion: 'unresolved',
}

const AiHotboardAuthContext = createContext<AiHotboardAuthContextValue>({
  ...UNRESOLVED_AUTH_SNAPSHOT,
  refreshAuth: async () => {},
})

let cachedAuthSnapshot: AiHotboardAuthSnapshot | null = null
let cachedAuthSnapshotFetchedAtMs = 0
let pendingAuthSnapshot: Promise<AiHotboardAuthSnapshot> | null = null

const DEFAULT_AUTH_CACHE_TTL_MS = 60_000
const DEFAULT_AUTH_REVALIDATE_INTERVAL_MS = 60_000
const AUTH_SYNC_CHANNEL_NAME = 'ai-hotboard-auth'
const AUTH_SYNC_STORAGE_KEY = 'ai-hotboard-auth-sync'

type AuthSyncReason = 'logout' | 'role-change'

type AuthSyncMessage = {
  id: string
  reason: AuthSyncReason
  sessionVersion?: string
  sentAt: number
}

function resolveAuthCacheTtlMs() {
  const configured = Number.parseInt(import.meta.env.VITE_HOTBOARD_AUTH_CACHE_TTL_MS ?? '', 10)
  if (Number.isFinite(configured) && configured >= 0) return configured
  return DEFAULT_AUTH_CACHE_TTL_MS
}

export function resolveAuthRevalidateIntervalMs() {
  const env = import.meta.env as Record<string, string | undefined>
  const configured = Number.parseInt(
    env.HOTBOARD_AUTH_REVALIDATE_INTERVAL_MS ?? env.VITE_HOTBOARD_AUTH_REVALIDATE_INTERVAL_MS ?? '',
    10,
  )
  if (Number.isFinite(configured) && configured > 0) return configured
  return DEFAULT_AUTH_REVALIDATE_INTERVAL_MS
}

export function redirectToAiHotboardLogin() {
  if (typeof window === 'undefined') return
  if (window.location.pathname !== '/ai-hotboard') {
    window.history.replaceState(null, '', '/ai-hotboard')
  }
}

export function startAiHotboardAuthRevalidationTimer({
  refreshAuth,
  documentRef = typeof document === 'undefined' ? null : document,
  intervalMs = resolveAuthRevalidateIntervalMs(),
}: {
  refreshAuth: () => void | Promise<void>
  documentRef?: Document | null
  intervalMs?: number
}) {
  if (!documentRef) return () => {}

  let timer: ReturnType<typeof setInterval> | null = null

  const stopTimer = () => {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  const revalidateIfVisible = () => {
    if (documentRef.visibilityState === 'hidden') return
    void refreshAuth()
  }

  const startTimer = () => {
    if (timer || documentRef.visibilityState === 'hidden') return
    timer = setInterval(revalidateIfVisible, intervalMs)
  }

  const handleVisibilityChange = () => {
    if (documentRef.visibilityState === 'hidden') {
      stopTimer()
      return
    }

    startTimer()
    revalidateIfVisible()
  }

  startTimer()
  documentRef.addEventListener('visibilitychange', handleVisibilityChange)

  return () => {
    stopTimer()
    documentRef.removeEventListener('visibilitychange', handleVisibilityChange)
  }
}

function isCachedAuthSnapshotFresh() {
  if (!cachedAuthSnapshot) return false
  return Date.now() - cachedAuthSnapshotFetchedAtMs <= resolveAuthCacheTtlMs()
}

function buildSessionVersion(auth: Awaited<ReturnType<typeof fetchHermesAuthStatus>>) {
  if (auth.session_version) return auth.session_version
  if (!auth.authenticated || !auth.user) return `anonymous:${auth.authMode ?? 'unknown'}`
  return `${auth.user.id}:${auth.user.role}`
}

function buildAuthErrorSnapshot(error: unknown): AiHotboardAuthSnapshot {
  return {
    authUser: null,
    authResolved: true,
    authRequired: true,
    authCheckError: error instanceof Error ? error.message : 'auth check failed',
    sessionVersion: `auth-error:${Date.now()}`,
  }
}

function hasAuthIdentityChanged(previous: AiHotboardAuthSnapshot | null, next: AiHotboardAuthSnapshot) {
  if (!previous) return false
  if (previous.sessionVersion !== next.sessionVersion) return true
  return (previous.authUser?.role ?? null) !== (next.authUser?.role ?? null)
}

function createAuthSyncMessage(reason: AuthSyncReason, sessionVersion?: string): AuthSyncMessage {
  return {
    id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
    reason,
    sessionVersion,
    sentAt: Date.now(),
  }
}

function broadcastAuthSync(reason: AuthSyncReason, sessionVersion?: string) {
  if (typeof window === 'undefined') return
  const message = createAuthSyncMessage(reason, sessionVersion)

  try {
    const channel = new BroadcastChannel(AUTH_SYNC_CHANNEL_NAME)
    channel.postMessage(message)
    channel.close()
  } catch {
    // BroadcastChannel is best-effort; storage event below is the fallback.
  }

  try {
    window.localStorage.setItem(AUTH_SYNC_STORAGE_KEY, JSON.stringify(message))
  } catch {
    // localStorage can be unavailable in private contexts.
  }
}

export function clearAiHotboardAuthCache({
  broadcast = false,
  reason = 'logout',
}: {
  broadcast?: boolean
  reason?: AuthSyncReason
} = {}) {
  cachedAuthSnapshot = null
  cachedAuthSnapshotFetchedAtMs = 0
  pendingAuthSnapshot = null
  if (broadcast) broadcastAuthSync(reason)
}

function toAuthSnapshot(auth: Awaited<ReturnType<typeof fetchHermesAuthStatus>>): AiHotboardAuthSnapshot {
  return {
    authUser: auth.user?.feishu_open_id || auth.user?.email ? auth.user : null,
    authResolved: true,
    authRequired: Boolean(auth.authRequired && !auth.authenticated),
    authCheckError: null,
    sessionVersion: buildSessionVersion(auth),
  }
}

export async function fetchCachedAuthSnapshot({ force = false }: { force?: boolean } = {}) {
  if (!force && isCachedAuthSnapshotFresh() && cachedAuthSnapshot) return cachedAuthSnapshot
  if (!force && pendingAuthSnapshot) return pendingAuthSnapshot

  const previousSnapshot = cachedAuthSnapshot

  pendingAuthSnapshot = fetchHermesAuthStatus()
    .then(toAuthSnapshot)
    .catch((error): AiHotboardAuthSnapshot => {
      const snapshot = buildAuthErrorSnapshot(error)
      if (snapshot.authCheckError?.includes('HTTP 401')) {
        broadcastAuthSync('logout')
      }
      return snapshot
    })
    .then((snapshot) => {
      cachedAuthSnapshot = snapshot
      cachedAuthSnapshotFetchedAtMs = Date.now()
      pendingAuthSnapshot = null
      if (!snapshot.authCheckError && hasAuthIdentityChanged(previousSnapshot, snapshot)) {
        broadcastAuthSync('role-change', snapshot.sessionVersion)
      }
      return snapshot
    })

  return pendingAuthSnapshot
}

export function resetAiHotboardAuthCacheForTests() {
  clearAiHotboardAuthCache()
}

export function AiHotboardAuthProvider({ children }: { children: ReactNode }) {
  const [authSnapshot, setAuthSnapshot] = useState<AiHotboardAuthSnapshot>(
    () => cachedAuthSnapshot ?? UNRESOLVED_AUTH_SNAPSHOT,
  )
  const stopAuthRevalidationRef = useRef<() => void>(() => {})

  const refreshAuth = useCallback(async () => {
    const snapshot = await fetchCachedAuthSnapshot({ force: true })
    setAuthSnapshot(snapshot)
  }, [])

  useEffect(() => {
    let cancelled = false

    void fetchCachedAuthSnapshot().then((snapshot) => {
      if (!cancelled) setAuthSnapshot(snapshot)
    })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    function revalidateOnFocus() {
      if (document.visibilityState === 'hidden') return
      void refreshAuth()
    }

    window.addEventListener('focus', revalidateOnFocus)

    return () => {
      window.removeEventListener('focus', revalidateOnFocus)
    }
  }, [refreshAuth])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    if (authSnapshot.authRequired) {
      stopAuthRevalidationRef.current()
      stopAuthRevalidationRef.current = () => {}
      return undefined
    }

    const stopTimer = startAiHotboardAuthRevalidationTimer({ refreshAuth })
    stopAuthRevalidationRef.current = stopTimer

    return () => {
      stopTimer()
      if (stopAuthRevalidationRef.current === stopTimer) {
        stopAuthRevalidationRef.current = () => {}
      }
    }
  }, [authSnapshot.authRequired, refreshAuth])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    let cancelled = false
    let channel: BroadcastChannel | null = null

    function handleAuthSync(message: AuthSyncMessage) {
      clearAiHotboardAuthCache()
      if (message.reason === 'logout') {
        stopAuthRevalidationRef.current()
        stopAuthRevalidationRef.current = () => {}
        setAuthSnapshot({
          authUser: null,
          authResolved: true,
          authRequired: true,
          authCheckError: null,
          sessionVersion: `logout:${message.sentAt}`,
        })
        redirectToAiHotboardLogin()
        return
      }

      void fetchCachedAuthSnapshot({ force: true }).then((snapshot) => {
        if (!cancelled) setAuthSnapshot(snapshot)
      })
    }

    try {
      channel = new BroadcastChannel(AUTH_SYNC_CHANNEL_NAME)
      channel.onmessage = (event: MessageEvent<AuthSyncMessage>) => {
        handleAuthSync(event.data)
      }
    } catch {
      channel = null
    }

    function handleStorage(event: StorageEvent) {
      if (event.key !== AUTH_SYNC_STORAGE_KEY || !event.newValue) return
      try {
        handleAuthSync(JSON.parse(event.newValue) as AuthSyncMessage)
      } catch {
        // Ignore malformed cross-tab messages.
      }
    }

    window.addEventListener('storage', handleStorage)

    return () => {
      cancelled = true
      window.removeEventListener('storage', handleStorage)
      channel?.close()
    }
  }, [])

  const contextValue = useMemo(
    () => ({
      ...authSnapshot,
      refreshAuth,
    }),
    [authSnapshot, refreshAuth],
  )

  return (
    <AiHotboardAuthContext.Provider value={contextValue}>
      {children}
    </AiHotboardAuthContext.Provider>
  )
}

export function useAiHotboardAuth() {
  return useContext(AiHotboardAuthContext)
}
