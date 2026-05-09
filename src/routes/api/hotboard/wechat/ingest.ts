import { json } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { getSessionUser, isAuthenticated } from '../../../../server/auth-middleware'
import { normalizeRole } from '../../../../server/auth-roles'
import {
  WechatFetchError,
  WechatFetchTimeoutError,
  ingestWechatUrl,
} from '../../../../server/hotboard-wechat-ingest'
import {
  rateLimit,
  rateLimitResponse,
  requireJsonContentType,
} from '../../../../server/rate-limit'

const WechatIngestSchema = z.object({
  url: z.string().trim().url().regex(/^https?:\/\/mp\.weixin\.qq\.com\/s(?:\/|\?)/),
})

function resolveSessionUserId(sessionUser: NonNullable<ReturnType<typeof getSessionUser>>) {
  return sessionUser.feishu_open_id || sessionUser.email || sessionUser.id
}

export async function handleHotboardWechatIngestPost(request: Request): Promise<Response> {
  if (!isAuthenticated(request)) {
    return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const sessionUser = getSessionUser(request)
  if (!sessionUser) {
    return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  if (normalizeRole(sessionUser.role) !== 'owner') {
    return json({ ok: false, error: 'Forbidden' }, { status: 403 })
  }

  const csrfCheck = requireJsonContentType(request)
  if (csrfCheck) return csrfCheck

  const userId = resolveSessionUserId(sessionUser)
  if (!rateLimit(`wechat-ingest:${userId}`, 30, 60_000)) {
    return rateLimitResponse()
  }

  const raw = await request.json().catch(() => ({}))
  const parsed = WechatIngestSchema.safeParse(raw)

  if (!parsed.success) {
    return json({ ok: false, error: 'Invalid request' }, { status: 400 })
  }

  try {
    const article = await ingestWechatUrl(parsed.data.url, userId)

    return json({
      ok: true,
      article: {
        id: article.id,
        url: article.url,
        title: article.title,
        author: article.author,
        publish_time: article.publish_time,
        excerpt: article.excerpt,
      },
    })
  } catch (error) {
    if (error instanceof WechatFetchTimeoutError) {
      return json({ ok: false, error: error.message }, { status: 504 })
    }

    if (error instanceof WechatFetchError) {
      return json({ ok: false, error: error.message }, { status: 502 })
    }

    return json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    )
  }
}

export const Route = createFileRoute('/api/hotboard/wechat/ingest')({
  server: {
    handlers: {
      POST: async ({ request }) => handleHotboardWechatIngestPost(request),
    },
  },
})
