import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => {
  const page = {
    goto: vi.fn(),
    waitForLoadState: vi.fn(),
    getByRole: vi.fn(),
    content: vi.fn(),
  }

  const browser = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  }

  return {
    page,
    browser,
    launch: vi.fn(async () => browser),
  }
})

vi.mock('playwright', () => ({
  chromium: {
    launch: mockState.launch,
  },
}))

import { parseZaraYoutubeHtml, scrapeZaraYoutubeLibrary } from './hotboard-zara-scraper'

const fixturePath = path.join(
  process.cwd(),
  'src/server/__fixtures__/zara-youtube-library.fixture.html',
)

afterEach(() => {
  mockState.launch.mockClear()
  mockState.browser.newPage.mockClear()
  mockState.browser.close.mockClear()
  mockState.page.goto.mockClear()
  mockState.page.waitForLoadState.mockClear()
  mockState.page.getByRole.mockClear()
  mockState.page.content.mockClear()
})

describe('hotboard zara scraper', () => {
  it('parses current faces card markup without article tags', () => {
    const items = parseZaraYoutubeHtml(`
      <div class="bg-white rounded-lg overflow-hidden shadow-sm border border-gray-100 flex flex-col">
        <div class="aspect-video w-full bg-black"><iframe src="https://www.youtube.com/embed/7xTGNNLPyMI"></iframe></div>
        <div class="flex flex-col h-full">
          <div class="flex-grow">
            <div class="mb-3 flex flex-wrap gap-2"><button>Fundamentals</button></div>
            <a href="https://www.youtube.com/watch?v=7xTGNNLPyMI" target="_blank"><p><strong>Deep Dive into LLMs like ChatGPT</strong></p></a>
            <p class="text-[#002BFF] opacity-60 font-semibold text-xs uppercase">Andrej Karpathy</p>
            <p>The best introduction into LLMs on the Internet</p>
          </div>
          <a href="https://tldw.us/analyze/7xTGNNLPyMI?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D7xTGNNLPyMI"><p>Watch on LongCut</p></a>
        </div>
      </div>
    `)

    expect(items).toEqual([
      {
        videoId: '7xTGNNLPyMI',
        url: 'https://www.youtube.com/watch?v=7xTGNNLPyMI',
        title: 'Deep Dive into LLMs like ChatGPT',
        channel: 'Andrej Karpathy',
        tags: ['Fundamentals'],
        description: 'The best introduction into LLMs on the Internet',
        thumbnailUrl: 'https://i.ytimg.com/vi/7xTGNNLPyMI/hqdefault.jpg',
      },
    ])
  })

  it('parses youtube cards from hydrated library html and expands the collection first', async () => {
    const click = vi.fn(async () => undefined)
    mockState.page.getByRole.mockReturnValue({ click })

    mockState.page.content.mockResolvedValue(fs.readFileSync(fixturePath, 'utf-8'))

    const items = await scrapeZaraYoutubeLibrary()

    expect(mockState.launch).toHaveBeenCalledWith({ headless: true })
    expect(mockState.page.goto).toHaveBeenCalledWith('https://zara.faces.site/ai', { waitUntil: 'domcontentloaded' })
    expect(mockState.page.waitForLoadState).toHaveBeenCalledWith('networkidle')
    expect(mockState.page.getByRole).toHaveBeenCalledWith('button', { name: /view complete collection/i })
    expect(click).toHaveBeenCalledTimes(1)
    expect(mockState.browser.close).toHaveBeenCalledTimes(1)

    expect(items).toEqual([
      {
        videoId: '7xTGNNLPyMI',
        url: 'https://www.youtube.com/watch?v=7xTGNNLPyMI',
        title: 'Deep Dive into LLMs like ChatGPT',
        channel: 'Andrej Karpathy',
        tags: ['Fundamentals'],
        description: 'The best introduction into LLMs on the Internet',
        thumbnailUrl: 'https://i.ytimg.com/vi/7xTGNNLPyMI/hqdefault.jpg',
      },
      {
        videoId: 'IcbuTTVUY7M',
        url: 'https://www.youtube.com/watch?v=IcbuTTVUY7M',
        title: 'How to Build a Beloved AI Product - Granola CEO Chris Pedregal',
        channel: 'The MAD Podcast with Matt Turck',
        tags: ['Product', 'Founder interview'],
        description: 'Learn from the founder of Granola, the AI PM that I admire the most',
        thumbnailUrl: 'https://i.ytimg.com/vi/IcbuTTVUY7M/hqdefault.jpg',
      },
      {
        videoId: 'ysPbXH0LpIE',
        url: 'https://youtu.be/ysPbXH0LpIE',
        title: 'Prompting 101 | Code w/ Claude',
        channel: 'Anthropic',
        tags: ['Prompting', 'Product', 'Practical tutorial'],
        description: 'Hands-on guidance on prompting from the Anthropic team',
        thumbnailUrl: 'https://i.ytimg.com/vi/ysPbXH0LpIE/hqdefault.jpg',
      },
    ])
  })

  it('always closes the browser when parsing fails', async () => {
    const click = vi.fn(async () => undefined)
    mockState.page.getByRole.mockReturnValue({ click })
    mockState.page.content.mockRejectedValue(new Error('parse failed'))

    await expect(scrapeZaraYoutubeLibrary()).rejects.toThrow('parse failed')
    expect(mockState.browser.close).toHaveBeenCalledTimes(1)
  })
})
