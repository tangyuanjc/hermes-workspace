import { json } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { getSessionUser, isAuthenticated } from '../../../server/auth-middleware'
import { normalizeRole } from '../../../server/auth-roles'
import { listSourceHealth, type SourceHealthEntry } from '../../../server/source-registry'

type SafeSourceHealthSummary = {
  source_name: string
  status_chip: SourceHealthEntry['status']
}

function toSafeSourceHealthSummary(source: SourceHealthEntry): SafeSourceHealthSummary {
  return {
    source_name: source.displayName,
    status_chip: source.status,
  }
}

export async function handleSourcesHealthGet(request: Request): Promise<Response> {
  if (!isAuthenticated(request)) {
    return json({ ok: false, error: 'Unauthorized', empty_reason: 'permission_denied' }, { status: 401 })
  }

  const sessionUser = getSessionUser(request)
  const role = normalizeRole(sessionUser?.role)
  if (!role) {
    return json({ ok: false, error: 'Forbidden' }, { status: 403 })
  }

  const sources = await listSourceHealth()

  if (role === 'owner') return json({ sources })
  return json({ sources: sources.map(toSafeSourceHealthSummary) })
}

export const Route = createFileRoute('/api/sources/health')({
  server: {
    handlers: {
      GET: async ({ request }) => handleSourcesHealthGet(request),
    },
  },
})
