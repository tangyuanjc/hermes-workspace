import { useQuery } from '@tanstack/react-query'
import type { EnhancedFeature } from '@/lib/feature-gates'

interface GatewayStatus {
  capabilities: Record<string, boolean>
  hermesUrl: string
}

export function useFeatureAvailable(
  feature: EnhancedFeature,
  enabled = true,
): boolean {
  const { data } = useQuery({
    queryKey: ['gateway-status'],
    queryFn: async () => {
      const res = await fetch('/api/gateway-status')
      if (!res.ok) return null
      return (await res.json()) as GatewayStatus
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    enabled,
  })

  return data?.capabilities?.[feature] === true
}
