import { createFileRoute } from '@tanstack/react-router'
import { handlePublicOptions, redirectPublicToAihot } from '../../../server/hotboard-public-api'

export const Route = createFileRoute('/api/public/daily')({
  server: {
    handlers: {
      GET: async ({ request }) => redirectPublicToAihot(request, 'daily'),
      OPTIONS: async ({ request }) => handlePublicOptions(request),
    },
  },
})
