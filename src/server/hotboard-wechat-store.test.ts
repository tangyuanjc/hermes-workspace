import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildWechatArticleId,
  createWechatStore,
  getWechatDbPath,
  normalizeWechatUrl,
} from './hotboard-wechat-store'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

function createTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotboard-wechat-store-'))
  tempDirs.push(tempDir)
  return path.join(tempDir, 'hotboard-wechat.sqlite')
}

describe('hotboard wechat store', () => {
  it('defaults to the shared hotboard sqlite database', () => {
    expect(getWechatDbPath()).toMatch(/\.hermes\/data\/hotboard\.sqlite$/)
  })

  it('upserts by normalized url and resolves getArticleByUrl without query params', () => {
    const store = createWechatStore({ dbPath: createTempDbPath() })
    const canonicalUrl = normalizeWechatUrl('https://mp.weixin.qq.com/s/example-article?foo=1')

    const created = store.upsertArticle({
      id: buildWechatArticleId(canonicalUrl),
      url: canonicalUrl,
      title: '第一版标题',
      author: '机器之心',
      publish_time: '2026-04-23T15:56:00.000Z',
      size_bytes: 1024,
      markdown_path: '/tmp/wechat/article.md',
      excerpt: '第一版摘要',
      fetched_at: '2026-04-24T01:00:00.000Z',
      fetched_by_user_id: 'owner-1',
    })

    const updated = store.upsertArticle({
      ...created,
      url: 'https://mp.weixin.qq.com/s/example-article?bar=2',
      title: '第二版标题',
      excerpt: '第二版摘要',
      fetched_at: '2026-04-24T02:00:00.000Z',
    })

    const fetched = store.getArticleByUrl('https://mp.weixin.qq.com/s/example-article?baz=3')
    expect(updated.id).toBe(created.id)
    expect(fetched?.url).toBe(canonicalUrl)
    expect(fetched?.title).toBe('第二版标题')
    expect(fetched?.excerpt).toBe('第二版摘要')
  })

  it('preserves legacy /s identity query params while dropping tracking params', () => {
    const first = normalizeWechatUrl(
      'https://mp.weixin.qq.com/s?__biz=A&mid=1&idx=1&sn=aaa&utm_source=x&scene=21#wechat_redirect',
    )
    const second = normalizeWechatUrl(
      'https://mp.weixin.qq.com/s?__biz=B&mid=2&idx=1&sn=bbb&utm_source=x&scene=21',
    )
    const sameArticleWithTracking = normalizeWechatUrl(
      'https://mp.weixin.qq.com/s?scene=21&__biz=A&mid=1&idx=1&sn=aaa&utm_medium=y',
    )

    expect(first).toBe('https://mp.weixin.qq.com/s?__biz=A&mid=1&idx=1&sn=aaa')
    expect(second).toBe('https://mp.weixin.qq.com/s?__biz=B&mid=2&idx=1&sn=bbb')
    expect(first).not.toBe(second)
    expect(sameArticleWithTracking).toBe(first)
  })

  it('continues to drop search params for non-legacy paths', () => {
    expect(normalizeWechatUrl('https://mp.weixin.qq.com/s/token-1?__biz=A&mid=1#x')).toBe(
      'https://mp.weixin.qq.com/s/token-1',
    )
    expect(normalizeWechatUrl('https://mp.weixin.qq.com/news/article?utm_source=x')).toBe(
      'https://mp.weixin.qq.com/news/article',
    )
  })

  it('lists recent articles ordered by publish_time desc and respects limit', () => {
    const store = createWechatStore({ dbPath: createTempDbPath() })

    const articles = [
      {
        id: 'article-a',
        url: 'https://mp.weixin.qq.com/s/article-a',
        title: 'A',
        author: 'Author A',
        publish_time: '2026-04-22T10:00:00.000Z',
        size_bytes: 100,
        markdown_path: '/tmp/a.md',
        excerpt: 'A',
        fetched_at: '2026-04-24T01:00:00.000Z',
        fetched_by_user_id: 'owner-a',
      },
      {
        id: 'article-b',
        url: 'https://mp.weixin.qq.com/s/article-b',
        title: 'B',
        author: 'Author B',
        publish_time: '2026-04-24T10:00:00.000Z',
        size_bytes: 200,
        markdown_path: '/tmp/b.md',
        excerpt: 'B',
        fetched_at: '2026-04-24T02:00:00.000Z',
        fetched_by_user_id: 'owner-b',
      },
      {
        id: 'article-c',
        url: 'https://mp.weixin.qq.com/s/article-c',
        title: 'C',
        author: 'Author C',
        publish_time: null,
        size_bytes: 300,
        markdown_path: '/tmp/c.md',
        excerpt: 'C',
        fetched_at: '2026-04-24T03:00:00.000Z',
        fetched_by_user_id: 'owner-c',
      },
    ]

    articles.forEach((article) => {
      store.upsertArticle(article)
    })

    const list = store.listRecentArticles(2)
    expect(list).toHaveLength(2)
    expect(list.map((item) => item.id)).toEqual(['article-b', 'article-c'])
  })
})
