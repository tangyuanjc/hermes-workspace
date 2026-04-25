import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { getSessionWithUser } from '../../server/auth-middleware'

export function handleWhoamiGet(request: Request) {
  const session = getSessionWithUser(request)
  if (!session) {
    return json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  return json({
    user_id: session.user.id,
    role: session.user.role,
    displayName: session.user.display_name,
    session_created_at: session.created_at,
    session_expires_at: session.expires_at,
  })
}

export const Route = createFileRoute('/api/whoami')({
  server: {
    handlers: {
      GET: async ({ request }) => handleWhoamiGet(request),
    },
  },
})
