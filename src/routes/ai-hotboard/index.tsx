import { createFileRoute } from '@tanstack/react-router'
import { AiHotboardRouteContent } from '../ai-hotboard'

export const Route = createFileRoute('/ai-hotboard/')({
  component: AiHotboardFeaturedRoute,
})

function AiHotboardFeaturedRoute() {
  return <AiHotboardRouteContent page="view-all" source="all" />
}
