import { createFileRoute } from '@tanstack/react-router'
import { handlePublicItemsGet, handlePublicOptions } from '../../../server/hotboard-public-api'

export const Route = createFileRoute('/api/public/items')({
  server: {
    handlers: {
      GET: async ({ request }) => handlePublicItemsGet(request),
      OPTIONS: async ({ request }) => handlePublicOptions(request),
    },
  },
})
