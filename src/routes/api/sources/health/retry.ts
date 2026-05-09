import { json } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { getSessionUser, isAuthenticated } from '../../../../server/auth-middleware'
import { normalizeRole } from '../../../../server/auth-roles'
import { retrySource } from '../../../../server/source-registry'

export async function handleSourcesHealthRetryPost(request: Request): Promise<Response> {
  if (!isAuthenticated(request)) {
    return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const sessionUser = getSessionUser(request)
  if (normalizeRole(sessionUser?.role) !== 'owner') {
    return json({ ok: false, error: 'Forbidden' }, { status: 403 })
  }

  let sourceId = ''
  try {
    const body = await request.json() as { source_id?: string }
    sourceId = body.source_id?.trim() ?? ''
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!sourceId) {
    return json({ ok: false, error: 'source_id is required' }, { status: 400 })
  }

  const retry = await retrySource(sourceId)
  return json({ ok: true, retry })
}

export const Route = createFileRoute('/api/sources/health/retry')({
  server: {
    handlers: {
      POST: async ({ request }) => handleSourcesHealthRetryPost(request),
    },
  },
})
