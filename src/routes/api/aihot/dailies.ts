import { createFileRoute } from '@tanstack/react-router'
import { handlePublicDailiesGet, handlePublicOptions } from '../../../server/hotboard-public-api'

export const Route = createFileRoute('/api/aihot/dailies')({
  server: {
    handlers: {
      GET: async ({ request }) => handlePublicDailiesGet(request),
      OPTIONS: async ({ request }) => handlePublicOptions(request),
    },
  },
})
