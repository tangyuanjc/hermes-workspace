import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { calculateSourceHealth, listSourceHealth, retrySource } from './source-registry'

const tempDirs: string[] = []

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-registry-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function createZaraDb(dbPath: string, lastRefreshedAt: string) {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE zara_youtube_items (
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
  `)
  db.prepare(`
    INSERT INTO zara_youtube_items (
      video_id, url, title, tags_json, first_seen_at, last_refreshed_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run('video-1', 'https://youtube.com/watch?v=video-1', 'Video 1', '[]', lastRefreshedAt, lastRefreshedAt)
  db.close()
}

describe('source registry health', () => {
  it('calculates green, yellow, and red statuses from interval and failures', () => {
    const nowMs = Date.parse('2026-04-26T12:00:00.000Z')
    const intervalMs = 60 * 60 * 1000

    expect(calculateSourceHealth({
      nowMs,
      intervalMs,
      lastSuccessAt: '2026-04-26T11:30:00.000Z',
      count: 2,
    }).status).toBe('green')

    expect(calculateSourceHealth({
      nowMs,
      intervalMs,
      lastSuccessAt: '2026-04-26T10:30:00.000Z',
      count: 2,
    }).status).toBe('yellow')

    expect(calculateSourceHealth({
      nowMs,
      intervalMs,
      lastSuccessAt: '2026-04-26T09:30:00.000Z',
      count: 2,
    }).status).toBe('red')

    expect(calculateSourceHealth({
      nowMs,
      intervalMs,
      lastSuccessAt: '2026-04-26T11:30:00.000Z',
      lastFailureAt: '2026-04-26T11:45:00.000Z',
      count: 2,
    }).status).toBe('red')
  })

  it('returns the four registered source health entries', async () => {
    const dir = makeTempDir()
    const zaraDbPath = path.join(dir, 'hotboard-zara.sqlite')
    const hotboardDbPath = path.join(dir, 'hotboard.sqlite')
    const xSignalLatestPath = path.join(dir, 'x_signal_sync_latest.json')
    createZaraDb(zaraDbPath, '2026-04-26T11:30:00.000Z')
    fs.writeFileSync(xSignalLatestPath, JSON.stringify({
      generated_at: '2026-04-26T10:00:00.000Z',
      counts: { bookmarks: 3, likes: 2 },
    }))

    const sources = await listSourceHealth({
      zaraDbPath,
      hotboardDbPath,
      xSignalLatestPath,
      now: () => new Date('2026-04-26T12:00:00.000Z'),
    })

    expect(sources.map((source) => source.id)).toEqual([
      'zara-youtube',
      'x-signal',
      'wechat-articles',
      'jc-conversations',
    ])
    expect(sources.find((source) => source.id === 'zara-youtube')?.status).toBe('green')
    expect(sources.find((source) => source.id === 'x-signal')?.count).toBe(5)
    expect(sources.find((source) => source.id === 'jc-conversations')?.status).toBe('yellow')
  })
})

describe('source retry rate limit', () => {
  it('allows three retries per source within 24 hours and skips the fourth', async () => {
    const dir = makeTempDir()
    const hotboardDbPath = path.join(dir, 'hotboard.sqlite')
    const runLaunchd = vi.fn().mockResolvedValue(undefined)
    const now = () => new Date('2026-04-26T12:00:00.000Z')

    const first = await retrySource('x-signal', { hotboardDbPath, now, runLaunchd })
    const second = await retrySource('x-signal', { hotboardDbPath, now, runLaunchd })
    const third = await retrySource('x-signal', { hotboardDbPath, now, runLaunchd })
    const fourth = await retrySource('x-signal', { hotboardDbPath, now, runLaunchd })

    expect([first.result, second.result, third.result, fourth.result]).toEqual([
      'triggered',
      'triggered',
      'triggered',
      'skipped-rate-limit',
    ])
    expect(runLaunchd).toHaveBeenCalledTimes(3)

    const db = new DatabaseSync(hotboardDbPath, { readOnly: true })
    const rows = db.prepare('SELECT source_id, result FROM source_retry_log ORDER BY id ASC').all()
    db.close()
    expect(rows).toEqual([
      { source_id: 'x-signal', result: 'triggered' },
      { source_id: 'x-signal', result: 'triggered' },
      { source_id: 'x-signal', result: 'triggered' },
      { source_id: 'x-signal', result: 'skipped-rate-limit' },
    ])
  })
})
