import { json } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { getSessionUser, isAuthenticated } from '../../../../server/auth-middleware'
import { scrapeZaraYoutubeLibrary } from '../../../../server/hotboard-zara-scraper'
import { createZaraStore } from '../../../../server/hotboard-zara-store'
import { rateLimit, rateLimitResponse, requireJsonContentType } from '../../../../server/rate-limit'

function resolveSessionUserId(sessionUser: NonNullable<ReturnType<typeof getSessionUser>>) {
  return sessionUser.feishu_open_id || sessionUser.email || sessionUser.id
}

export async function handleHotboardZaraRefreshPost(request: Request): Promise<Response> {
  if (!isAuthenticated(request)) {
    return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const sessionUser = getSessionUser(request)
  if (!sessionUser) {
    return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  if (sessionUser.role !== 'owner') {
    return json({ ok: false, error: 'Forbidden' }, { status: 403 })
  }

  const csrfCheck = requireJsonContentType(request)
  if (csrfCheck) return csrfCheck

  const userId = resolveSessionUserId(sessionUser)
  if (!rateLimit(`zara-refresh:${userId}`, 3, 60 * 60 * 1000)) {
    return rateLimitResponse()
  }

  const items = await scrapeZaraYoutubeLibrary()
  if (items.length === 0) {
    return json({
      ok: true,
      added: 0,
      updated: 0,
      total: 0,
      items: [],
      message: 'no items detected',
    })
  }

  const store = createZaraStore()
  const result = store.upsertItems(items)

  return json({
    ok: true,
    added: result.added,
    updated: result.updated,
    total: result.total,
  })
}

export const Route = createFileRoute('/api/hotboard/zara/refresh')({
  server: {
    handlers: {
      POST: async ({ request }) => handleHotboardZaraRefreshPost(request),
    },
  },
})
