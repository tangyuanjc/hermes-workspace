import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import {
  getSessionWithUser,
  isAuthenticated,
  isEmailAuthEnabled,
  isFeishuSsoEnabled,
  isPasswordProtectionEnabled,
} from '../../server/auth-middleware'
import {
  ensureGatewayProbed,
  getCapabilities,
} from '../../server/gateway-capabilities'

function refreshGatewayMetadataInBackground() {
  void Promise.resolve(ensureGatewayProbed()).catch(() => {
    // Gateway availability is optional metadata for auth-check.
  })
}

export const Route = createFileRoute('/api/auth-check')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const caps = getCapabilities()
        const hermesGatewayReachable =
          caps.health || caps.chatCompletions || caps.models
        if (!caps.probed) {
          refreshGatewayMetadataInBackground()
        }

        const authRequired =
          isPasswordProtectionEnabled() ||
          isFeishuSsoEnabled() ||
          isEmailAuthEnabled()
        const session = isAuthenticated(request)
          ? getSessionWithUser(request)
          : null
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
