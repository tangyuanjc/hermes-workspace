import { URL } from 'node:url'
import type { ZaraYoutubeItem } from './hotboard-zara-types'

const ZARA_LIBRARY_URL = 'https://zara.faces.site/ai'

type ScrapeResult = ZaraYoutubeItem[]

let runningPromise: Promise<ScrapeResult> | null = null

function extractVideoId(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.hostname.includes('youtu.be')) {
      return parsed.pathname.split('/').filter(Boolean)[0] ?? ''
    }
    if (parsed.hostname.includes('youtube.com')) {
      return parsed.searchParams.get('v') ?? ''
    }
  } catch {
    return ''
  }

  return ''
}

function buildYoutubeThumbnailUrl(url: string) {
  const videoId = extractVideoId(url)
  if (!videoId) return undefined
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
}

function normalizeText(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function textFromHtml(value: string | null | undefined) {
  return normalizeText(decodeHtmlEntities((value ?? '').replace(/<[^>]+>/g, ' ')))
}

function extractYoutubeHref(block: string) {
  const hrefMatch = block.match(/href="([^"]*(?:youtube\.com\/watch\?v=[^"&]+|youtu\.be\/[^"?&/]+)[^"]*)"/i)
  return hrefMatch ? decodeHtmlEntities(hrefMatch[1]) : ''
}

function parseYoutubeBlock(block: string): ZaraYoutubeItem | null {
  const url = extractYoutubeHref(block)
  const videoId = extractVideoId(url)
  if (!videoId) return null

  const titleMatch = block.match(/href="[^"]*(?:youtube\.com\/watch\?v=[^"]*|youtu\.be\/[^"]*)"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)
  const title = textFromHtml(titleMatch?.[1])
  if (!title || /^watch on longcut$/i.test(title)) return null

  const tagMatches = Array.from(block.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi), (match) =>
    textFromHtml(match[1]),
  ).filter(Boolean)

  const afterTitle = titleMatch?.index === undefined ? block : block.slice(titleMatch.index + titleMatch[0].length)
  const paragraphTexts = Array.from(afterTitle.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi), (match) =>
    textFromHtml(match[1]),
  ).filter((text) => text && !/^watch on longcut$/i.test(text))

  return {
    videoId,
    url,
    title,
    channel: paragraphTexts[0] || undefined,
    tags: tagMatches,
    description: paragraphTexts[1] || undefined,
    thumbnailUrl: buildYoutubeThumbnailUrl(url),
  }
}

function parseZaraYoutubeCards(html: string): ZaraYoutubeItem[] {
  const items: ZaraYoutubeItem[] = []
  const seen = new Set<string>()
  const cardMatches = Array.from(
    html.matchAll(/<div[^>]*class="[^"]*(?:bg-white[^"]*rounded|rounded[^"]*bg-white)[^"]*"[\s\S]*?(?=<div[^>]*class="[^"]*(?:bg-white[^"]*rounded|rounded[^"]*bg-white)[^"]*"|<article\b|$)/gi),
    (match) => match[0],
  )

  const candidateBlocks = cardMatches.length > 0 ? cardMatches : Array.from(
    html.matchAll(/<a[^>]+href="[^"]*(?:youtube\.com\/watch\?v=|youtu\.be\/)[^"]*"[\s\S]*?(?=<a[^>]+href="[^"]*(?:youtube\.com\/watch\?v=|youtu\.be\/)|$)/gi),
    (match) => match[0],
  )

  for (const block of candidateBlocks) {
    const item = parseYoutubeBlock(block)
    if (!item || seen.has(item.videoId)) continue
    seen.add(item.videoId)
    items.push(item)
  }

  return items
}

function parseZaraYoutubeArticles(html: string): ZaraYoutubeItem[] {
  const matches = Array.from(
    html.matchAll(/<article[\s\S]*?<\/article>/gi),
    (match) => match[0],
  )
  const items: ZaraYoutubeItem[] = []

  for (const article of matches) {
    const url = extractYoutubeHref(article)
    const videoId = extractVideoId(url)
    if (!videoId) continue

    const allDivTexts = Array.from(article.matchAll(/<div[^>]*>([^<>]+)<\/div>/gi), (match) =>
      normalizeText(match[1]),
    ).filter(Boolean)

    const buttonTags = Array.from(article.matchAll(/<button[^>]*>([^<>]+)<\/button>/gi), (match) =>
      normalizeText(match[1]),
    ).filter(Boolean)

    const imgMatch = article.match(/<img[^>]*src="([^"]+)"/i)
    const filteredText = allDivTexts.filter((text) => !buttonTags.includes(text))
    const title = filteredText[0] ?? ''
    const channel = filteredText[1] || undefined
    const description = filteredText[2] || undefined

    if (!title) continue

    items.push({
      videoId,
      url,
      title,
      channel,
      tags: buttonTags,
      description,
      thumbnailUrl: imgMatch?.[1] || buildYoutubeThumbnailUrl(url),
    })
  }

  return items
}

function dedupeByVideoId(items: ZaraYoutubeItem[]) {
  const seen = new Set<string>()
  const deduped: ZaraYoutubeItem[] = []
  for (const item of items) {
    if (seen.has(item.videoId)) continue
    seen.add(item.videoId)
    deduped.push(item)
  }
  return deduped
}

export function parseZaraYoutubeHtml(html: string): ZaraYoutubeItem[] {
  return dedupeByVideoId([
    ...parseZaraYoutubeArticles(html),
    ...parseZaraYoutubeCards(html),
  ])
}

async function runZaraYoutubeScrape(): Promise<ScrapeResult> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })

  try {
    const page = await browser.newPage()
    await page.goto(ZARA_LIBRARY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForLoadState('networkidle')

    const expandButton = page.getByRole('button', { name: /view complete collection/i })
    await expandButton.click()
    await page.waitForLoadState('networkidle')
    const html = await page.content()
    return parseZaraYoutubeHtml(html)
  } finally {
    await browser.close()
  }
}

export async function scrapeZaraYoutubeLibrary(): Promise<ScrapeResult> {
  if (runningPromise) return runningPromise

  runningPromise = runZaraYoutubeScrape()
  try {
    return await runningPromise
  } finally {
    runningPromise = null
  }
}
