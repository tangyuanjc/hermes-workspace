import { json } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { getSessionUser, isAuthenticated } from '../../../../server/auth-middleware'
import { createZaraStore } from '../../../../server/hotboard-zara-store'

const LimitSchema = z.coerce.number().int().min(1).max(200).default(50)

export async function handleHotboardZaraFeedGet(request: Request): Promise<Response> {
  if (!isAuthenticated(request)) {
    return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const sessionUser = getSessionUser(request)
  if (!sessionUser) {
    return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const limitParam = url.searchParams.get('limit') ?? '50'
  const parsedLimit = LimitSchema.safeParse(limitParam)

  if (!parsedLimit.success) {
    return json({ ok: false, error: 'Invalid limit query parameter' }, { status: 400 })
  }

  const store = createZaraStore()
  return json({
    last_refreshed_at: store.getLastRefreshedAt(),
    items: store.listAllItems(parsedLimit.data),
  })
}

export const Route = createFileRoute('/api/hotboard/zara/feed')({
  server: {
    handlers: {
      GET: async ({ request }) => handleHotboardZaraFeedGet(request),
    },
  },
})
