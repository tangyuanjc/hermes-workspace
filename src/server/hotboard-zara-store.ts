import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ZaraYoutubeItem } from './hotboard-zara-types'

type ZaraYoutubeRow = {
  video_id: string
  url: string
  title: string
  channel: string | null
  tags_json: string
  description: string | null
  thumbnail_url: string | null
  first_seen_at: string
  last_refreshed_at: string
}

const storeByPath = new Map<string, ZaraStore>()

function resolveZaraDbPath(dbPath?: string) {
  if (dbPath?.trim()) return dbPath.trim()

  const explicit = process.env.HERMES_HOTBOARD_ZARA_DB_PATH?.trim()
  if (explicit) return explicit

  return path.join(os.homedir(), '.hermes', 'data', 'hotboard-zara.sqlite')
}

function normalizeLimit(limit = 50) {
  if (!Number.isFinite(limit)) return 50
  return Math.max(1, Math.min(200, Math.trunc(limit)))
}

function nowIsoUtc() {
  return new Date().toISOString()
}

function mapRowToItem(row: ZaraYoutubeRow): ZaraYoutubeItem {
  return {
    videoId: row.video_id,
    url: row.url,
    title: row.title,
    channel: row.channel ?? undefined,
    tags: JSON.parse(row.tags_json) as string[],
    description: row.description ?? undefined,
    thumbnailUrl: row.thumbnail_url ?? undefined,
    firstSeenAt: row.first_seen_at,
    lastRefreshedAt: row.last_refreshed_at,
  }
}

export function createZaraStore(options: { dbPath?: string } = {}) {
  const dbPath = resolveZaraDbPath(options.dbPath)
  const existing = storeByPath.get(dbPath)
  if (existing) return existing

  const next = new ZaraStore(dbPath)
  storeByPath.set(dbPath, next)
  return next
}

export class ZaraStore {
  private readonly db: DatabaseSync

  constructor(private readonly dbPath: string) {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true })
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS zara_youtube_items (
        video_id TEXT PRIMARY KEY,
        url TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        channel TEXT,
        tags_json TEXT NOT NULL,
        description TEXT,
        thumbnail_url TEXT,
        first_seen_at TEXT NOT NULL,
        last_refreshed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_zara_first_seen
        ON zara_youtube_items(first_seen_at DESC);
    `)
  }

  upsertItems(items: ZaraYoutubeItem[]) {
    const now = nowIsoUtc()
    let added = 0
    let updated = 0

    const selectStmt = this.db.prepare(`
      SELECT
        video_id,
        url,
        title,
        channel,
        tags_json,
        description,
        thumbnail_url,
        first_seen_at,
        last_refreshed_at
      FROM zara_youtube_items
      WHERE video_id = ?
      LIMIT 1
    `)

    const upsertStmt = this.db.prepare(`
      INSERT INTO zara_youtube_items (
        video_id,
        url,
        title,
        channel,
        tags_json,
        description,
        thumbnail_url,
        first_seen_at,
        last_refreshed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        url = excluded.url,
        title = excluded.title,
        channel = excluded.channel,
        tags_json = excluded.tags_json,
        description = excluded.description,
        thumbnail_url = excluded.thumbnail_url,
        last_refreshed_at = excluded.last_refreshed_at
    `)

    for (const item of items) {
      const existing = selectStmt.get(item.videoId) as ZaraYoutubeRow | undefined
      if (existing) {
        updated += 1
      } else {
        added += 1
      }

      upsertStmt.run(
        item.videoId,
        item.url.trim(),
        item.title.trim(),
        item.channel?.trim() || null,
        JSON.stringify(item.tags),
        item.description?.trim() || null,
        item.thumbnailUrl?.trim() || null,
        existing?.first_seen_at ?? now,
        now,
      )
    }

    return {
      added,
      updated,
      total: this.listAllItems().length,
    }
  }

  listAllItems(limit = 200): ZaraYoutubeItem[] {
    const stmt = this.db.prepare(`
      SELECT
        video_id,
        url,
        title,
        channel,
        tags_json,
        description,
        thumbnail_url,
        first_seen_at,
        last_refreshed_at
      FROM zara_youtube_items
      ORDER BY datetime(first_seen_at) DESC, rowid DESC
      LIMIT ?
    `)

    return (stmt.all(normalizeLimit(limit)) as ZaraYoutubeRow[]).map(mapRowToItem)
  }

  getLastRefreshedAt(): string | null {
    const stmt = this.db.prepare(`
      SELECT MAX(last_refreshed_at) AS last_refreshed_at
      FROM zara_youtube_items
    `)
    const row = stmt.get() as { last_refreshed_at: string | null } | undefined
    return row?.last_refreshed_at ?? null
  }
}
