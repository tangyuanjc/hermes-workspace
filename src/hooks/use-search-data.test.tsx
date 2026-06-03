// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSearchData } from './use-search-data'

function renderSearchDataProbe(enabled: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })

  function Probe() {
    useSearchData('all', enabled)
    return null
  }

  const view = render(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  )

  return {
    ...view,
    queryClient,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useSearchData auth gate', () => {
  it('does not fetch gateway, files, sessions, or skills while disabled', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    renderSearchDataProbe(false)

    await new Promise((resolve) => window.setTimeout(resolve, 0))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches search backing APIs after it is enabled', async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url =
        input instanceof Request ? input.url : input instanceof URL ? input.href : input
      if (url === '/api/gateway-status') {
        return Promise.resolve(Response.json({
          capabilities: { sessions: true, skills: true },
          hermesUrl: 'http://gateway.test',
        }))
      }
      if (url.startsWith('/api/files')) return Promise.resolve(Response.json({ entries: [] }))
      if (url === '/api/sessions') return Promise.resolve(Response.json({ sessions: [] }))
      if (url.startsWith('/api/skills')) {
        return Promise.resolve(Response.json({ ok: true, skills: [] }))
      }
      return Promise.resolve(Response.json({}))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderSearchDataProbe(true)

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([input]) =>
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input,
      )
      expect(urls).toContain('/api/gateway-status')
      expect(urls).toContain('/api/files?action=list&maxDepth=5&maxEntries=2500')
      expect(urls).toContain('/api/sessions')
      expect(urls).toContain('/api/skills?summary=search&limit=120')
    })
  })
})
