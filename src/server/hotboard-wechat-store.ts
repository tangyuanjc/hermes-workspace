import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export type WechatArticleRecord = {
  id: string
  url: string
  title: string
  author: string | null
  publish_time: string | null
  size_bytes: number | null
  markdown_path: string
  excerpt: string
  fetched_at: string
  fetched_by_user_id: string
}

type WechatArticleRow = WechatArticleRecord

const storeByPath = new Map<string, WechatStore>()

function resolveWechatDbPath(dbPath?: string) {
  if (dbPath?.trim()) return dbPath.trim()

  const explicit = process.env.HERMES_HOTBOARD_WECHAT_DB_PATH?.trim()
  if (explicit) return explicit

  return path.join(os.homedir(), '.hermes', 'data', 'hotboard.sqlite')
}

function normalizeLimit(limit = 50) {
  if (!Number.isFinite(limit)) return 50
  return Math.max(1, Math.min(200, Math.trunc(limit)))
}

export function normalizeWechatUrl(url: string) {
  const parsed = new URL(url.trim())
  parsed.hash = ''

  if (parsed.pathname === '/s') {
    const preserved = new URLSearchParams()
    for (const key of ['__biz', 'mid', 'idx', 'sn']) {
      const value = parsed.searchParams.get(key)
      if (value !== null) preserved.set(key, value)
    }
    parsed.search = preserved.toString()
  } else {
    parsed.search = ''
  }

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1)
  }

  return `${parsed.origin}${parsed.pathname}${parsed.search}`
}

export function buildWechatArticleId(url: string) {
  return createHash('sha256').update(normalizeWechatUrl(url)).digest('hex').slice(0, 16)
}

export function createWechatStore(options: { dbPath?: string } = {}) {
  const dbPath = resolveWechatDbPath(options.dbPath)
  const existing = storeByPath.get(dbPath)
  if (existing) return existing

  const next = new WechatStore(dbPath)
  storeByPath.set(dbPath, next)
  return next
}

export function getWechatDbPath(options: { dbPath?: string } = {}) {
  return resolveWechatDbPath(options.dbPath)
}

export function upsertArticle(
  record: WechatArticleRecord,
  options: { dbPath?: string } = {},
) {
  return createWechatStore(options).upsertArticle(record)
}

export function listRecentArticles(limit = 50, options: { dbPath?: string } = {}) {
  return createWechatStore(options).listRecentArticles(limit)
}

export function getArticleByUrl(url: string, options: { dbPath?: string } = {}) {
  return createWechatStore(options).getArticleByUrl(url)
}

class WechatStore {
  private readonly db: DatabaseSync

  constructor(private readonly dbPath: string) {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true })
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wechat_articles (
        id TEXT PRIMARY KEY,
        url TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        publish_time TEXT,
        size_bytes INTEGER,
        markdown_path TEXT NOT NULL,
        excerpt TEXT NOT NULL DEFAULT '',
        fetched_at TEXT NOT NULL,
        fetched_by_user_id TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_wechat_publish_time
        ON wechat_articles(publish_time DESC);
    `)
  }

  upsertArticle(record: WechatArticleRecord): WechatArticleRecord {
    const normalizedUrl = normalizeWechatUrl(record.url)
    const normalizedId = record.id?.trim() || buildWechatArticleId(normalizedUrl)

    const stmt = this.db.prepare(`
      INSERT INTO wechat_articles (
        id,
        url,
        title,
        author,
        publish_time,
        size_bytes,
        markdown_path,
        excerpt,
        fetched_at,
        fetched_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        id = excluded.id,
        title = excluded.title,
        author = excluded.author,
        publish_time = excluded.publish_time,
        size_bytes = excluded.size_bytes,
        markdown_path = excluded.markdown_path,
        excerpt = excluded.excerpt,
        fetched_at = excluded.fetched_at,
        fetched_by_user_id = excluded.fetched_by_user_id
    `)

    stmt.run(
      normalizedId,
      normalizedUrl,
      record.title.trim(),
      record.author?.trim() || null,
      record.publish_time?.trim() || null,
      record.size_bytes ?? null,
      path.resolve(record.markdown_path),
      record.excerpt.trim(),
      record.fetched_at.trim(),
      record.fetched_by_user_id.trim(),
    )

    const saved = this.getArticleByUrl(normalizedUrl)
    if (!saved) {
      throw new Error('Failed to persist wechat article')
    }

    return saved
  }

  listRecentArticles(limit = 50): WechatArticleRecord[] {
    const stmt = this.db.prepare(`
      SELECT
        id,
        url,
        title,
        author,
        publish_time,
        size_bytes,
        markdown_path,
        excerpt,
        fetched_at,
        fetched_by_user_id
      FROM wechat_articles
      ORDER BY
        datetime(COALESCE(publish_time, fetched_at)) DESC,
        datetime(fetched_at) DESC,
        rowid DESC
      LIMIT ?
    `)

    return (stmt.all(normalizeLimit(limit)) as WechatArticleRow[]).map((row) => ({ ...row }))
  }

  getArticleByUrl(url: string): WechatArticleRecord | null {
    const stmt = this.db.prepare(`
      SELECT
        id,
        url,
        title,
        author,
        publish_time,
        size_bytes,
        markdown_path,
        excerpt,
        fetched_at,
        fetched_by_user_id
      FROM wechat_articles
      WHERE url = ?
      LIMIT 1
    `)

    return (stmt.get(normalizeWechatUrl(url)) as WechatArticleRow | undefined) ?? null
  }
}
