import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import {
  getSessionWithUser,
  isAuthenticated,
  isEmailAuthEnabled,
  isFeishuSsoEnabled,
  isPasswordProtectionEnabled,
} from '../../server/auth-middleware'
import { ensureGatewayProbed } from '../../server/gateway-capabilities'

export const Route = createFileRoute('/api/auth-check')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Gateway probe is best-effort metadata, NOT auth gating.
        // ai-hotboard auth uses local SQLite session store independent of
        // hermes-agent HTTP gateway. If gateway is down, login still works.
        let hermesGatewayReachable = false
        try {
          const caps = await ensureGatewayProbed()
          hermesGatewayReachable =
            caps.health || caps.chatCompletions || caps.models
        } catch {
          hermesGatewayReachable = false
        }

        const authRequired =
          isPasswordProtectionEnabled() ||
          isFeishuSsoEnabled() ||
          isEmailAuthEnabled()
        const session = isAuthenticated(request) ? getSessionWithUser(request) : null
        const authenticated = session !== null
        const user = session?.user ?? null

        const authMode = isEmailAuthEnabled()
          ? 'email_magic_link'
          : isFeishuSsoEnabled()
          ? 'feishu_sso'
          : authRequired
          ? 'password'
          : 'none'

        return json({
          authenticated,
          authRequired,
          authMode,
          hermesGatewayReachable,
          session_version: user
            ? `${user.id}:${user.role}:${user.last_login_at}:${session?.expires_at ?? ''}`
            : `anonymous:${authMode}`,
          user: user
            ? {
                id: user.id,
                feishu_open_id: user.feishu_open_id,
                feishu_union_id: user.feishu_union_id,
                email: user.email,
                display_name: user.display_name,
                role: user.role,
              }
            : null,
        })
      },
    },
  },
})
