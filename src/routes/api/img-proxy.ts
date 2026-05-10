import { createFileRoute } from '@tanstack/react-router'
import { handleImgProxyGet } from '../../server/img-proxy-api'

export const Route = createFileRoute('/api/img-proxy')({
  server: {
    handlers: {
      GET: async ({ request }) => handleImgProxyGet(request),
    },
  },
})
