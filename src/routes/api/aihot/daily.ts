import { createFileRoute } from '@tanstack/react-router'
import { handlePublicDailyGet, handlePublicOptions } from '../../../server/hotboard-public-api'

export const Route = createFileRoute('/api/aihot/daily')({
  server: {
    handlers: {
      GET: async ({ request }) => handlePublicDailyGet(request),
      OPTIONS: async ({ request }) => handlePublicOptions(request),
    },
  },
})
