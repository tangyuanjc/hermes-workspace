import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { fetchHermesAuthStatus, type AuthUser } from '@/lib/hermes-auth'

type AiHotboardAuthSnapshot = {
  authUser: AuthUser | null
  authResolved: boolean
  authRequired: boolean
  authCheckError: string | null
}

type AiHotboardAuthContextValue = AiHotboardAuthSnapshot & {
  refreshAuth: () => Promise<void>
}

const UNRESOLVED_AUTH_SNAPSHOT: AiHotboardAuthSnapshot = {
  authUser: null,
  authResolved: false,
  authRequired: false,
  authCheckError: null,
}

const AiHotboardAuthContext = createContext<AiHotboardAuthContextValue>({
  ...UNRESOLVED_AUTH_SNAPSHOT,
  refreshAuth: async () => {},
})

let cachedAuthSnapshot: AiHotboardAuthSnapshot | null = null
let pendingAuthSnapshot: Promise<AiHotboardAuthSnapshot> | null = null

function toAuthSnapshot(auth: Awaited<ReturnType<typeof fetchHermesAuthStatus>>): AiHotboardAuthSnapshot {
  return {
    authUser: auth.user?.feishu_open_id || auth.user?.email ? auth.user : null,
    authResolved: true,
    authRequired: Boolean(auth.authRequired && !auth.authenticated),
    authCheckError: null,
  }
}

async function fetchCachedAuthSnapshot({ force = false }: { force?: boolean } = {}) {
  if (!force && cachedAuthSnapshot) return cachedAuthSnapshot
  if (!force && pendingAuthSnapshot) return pendingAuthSnapshot

  pendingAuthSnapshot = fetchHermesAuthStatus()
    .then(toAuthSnapshot)
    .catch((error): AiHotboardAuthSnapshot => ({
      authUser: null,
      authResolved: true,
      authRequired: false,
      authCheckError: error instanceof Error ? error.message : 'auth check failed',
    }))
    .then((snapshot) => {
      cachedAuthSnapshot = snapshot
      pendingAuthSnapshot = null
      return snapshot
    })

  return pendingAuthSnapshot
}

export function resetAiHotboardAuthCacheForTests() {
  cachedAuthSnapshot = null
  pendingAuthSnapshot = null
}

export function AiHotboardAuthProvider({ children }: { children: ReactNode }) {
  const [authSnapshot, setAuthSnapshot] = useState<AiHotboardAuthSnapshot>(
    () => cachedAuthSnapshot ?? UNRESOLVED_AUTH_SNAPSHOT,
  )

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
