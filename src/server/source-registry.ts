import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { scrapeZaraYoutubeLibrary } from './hotboard-zara-scraper'
import { createZaraStore } from './hotboard-zara-store'

const execFileAsync = promisify(execFile)

export type SourceKind = 'scheduler' | 'launchd' | 'manual'

export interface SourceDescriptor {
  id: string
  displayName: string
  kind: SourceKind
  trigger: string
  getHealth(): Promise<SourceHealth>
}

export interface SourceHealth {
  last_success_at: string | null
  last_failure_at: string | null
  last_failure_reason: string | null
  count: number
  status: 'green' | 'yellow' | 'red'
}

export type SourceHealthEntry = SourceHealth & {
  id: string
  displayName: string
  kind: SourceKind
  trigger: string
}

type SourceStatus = SourceHealth['status']

type HealthInput = {
  nowMs?: number
  intervalMs: number
  lastSuccessAt: string | null
  lastFailureAt?: string | null
  lastFailureReason?: string | null
  count: number
}

type RetryResult = {
  source_id: string
  triggered_at: string
  result: 'triggered' | 'skipped-rate-limit' | 'skipped-no-trigger' | 'failed'
  error?: string
}

type SourceRegistryOptions = {
  zaraDbPath?: string
  hotboardDbPath?: string
  xSignalLatestPath?: string
  now?: () => Date
  runLaunchd?: (label: string) => Promise<void>
  runZaraRefresh?: () => Promise<void>
}

const ZARA_INTERVAL_MS = 60 * 60 * 1000
const X_SIGNAL_INTERVAL_MS = 6 * 60 * 60 * 1000
const MANUAL_INTERVAL_MS = 24 * 60 * 60 * 1000
const RETRY_LIMIT = 3
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000
const X_SIGNAL_LAUNCHD_LABEL = 'ai.hermes.x-signal-sync'

function resolveHotboardDbPath(dbPath?: string) {
  if (dbPath?.trim()) return dbPath.trim()
  const explicit = process.env.HERMES_HOTBOARD_WECHAT_DB_PATH?.trim()
  if (explicit) return explicit
  return path.join(os.homedir(), '.hermes', 'data', 'hotboard.sqlite')
}

export function resolveXSignalLatestPath(filePath?: string) {
  if (filePath?.trim()) return filePath.trim()
  const explicit = process.env.HOTBOARD_X_SIGNAL_PATH?.trim()
  if (explicit) return explicit
  return path.join(os.homedir(), '.hermes', 'tmp', 'x_signal_sync_latest.json')
}

function parseIsoMs(value: string | null) {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isAfter(left: string | null, right: string | null) {
  const leftMs = parseIsoMs(left)
  const rightMs = parseIsoMs(right)
  if (leftMs === null) return false
  if (rightMs === null) return true
  return leftMs > rightMs
}

export function calculateSourceHealth(input: HealthInput): SourceHealth {
  const lastSuccessMs = parseIsoMs(input.lastSuccessAt)
  const nowMs = input.nowMs ?? Date.now()
  const ageMs = lastSuccessMs === null ? null : nowMs - lastSuccessMs
  let status: SourceStatus

  if (input.count <= 0) {
    status = lastSuccessMs === null || (ageMs !== null && ageMs <= input.intervalMs) ? 'yellow' : 'red'
  } else if (input.lastFailureAt && isAfter(input.lastFailureAt, input.lastSuccessAt)) {
    status = 'red'
  } else if (lastSuccessMs === null) {
    status = 'yellow'
  } else if (ageMs !== null && ageMs <= input.intervalMs) {
    status = 'green'
  } else if (ageMs !== null && ageMs <= input.intervalMs * 2) {
    status = 'yellow'
  } else {
    status = 'red'
  }

  return {
    last_success_at: input.lastSuccessAt,
    last_failure_at: input.lastFailureAt ?? null,
    last_failure_reason: input.lastFailureReason ?? null,
    count: input.count,
    status,
  }
}

function readSqliteHealth({
  dbPath,
  tableName,
  timestampColumn,
  intervalMs,
  nowMs,
}: {
  dbPath: string
  tableName: string
  timestampColumn: string
  intervalMs: number
  nowMs: number
}) {
  if (!fs.existsSync(dbPath)) {
    return calculateSourceHealth({ intervalMs, lastSuccessAt: null, count: 0, nowMs })
  }

  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS count, MAX(${timestampColumn}) AS last_success_at
      FROM ${tableName}
    `).get() as { count: number; last_success_at: string | null } | undefined

    return calculateSourceHealth({
      intervalMs,
      lastSuccessAt: row?.last_success_at ?? null,
      count: row?.count ?? 0,
      nowMs,
    })
  } finally {
    db.close()
  }
}

function readXSignalHealth(filePath: string, nowMs: number) {
  if (!fs.existsSync(filePath)) {
    return calculateSourceHealth({ intervalMs: X_SIGNAL_INTERVAL_MS, lastSuccessAt: null, count: 0, nowMs })
  }

  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      generated_at?: string
      counts?: Record<string, unknown>
      count?: number
      total?: number
      last_failure_at?: string | null
      last_failure_reason?: string | null
    }
    const count: number = typeof payload.count === 'number'
      ? payload.count
      : typeof payload.total === 'number'
        ? payload.total
        : sumXSignalCounts(payload.counts ?? {})

    return calculateSourceHealth({
      intervalMs: X_SIGNAL_INTERVAL_MS,
      lastSuccessAt: payload.generated_at ?? null,
      lastFailureAt: payload.last_failure_at ?? null,
      lastFailureReason: payload.last_failure_reason ?? null,
      count,
      nowMs,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      last_success_at: null,
      last_failure_at: new Date(nowMs).toISOString(),
      last_failure_reason: reason,
      count: 0,
      status: 'red' as const,
    }
  }
}

function readXSignalCountValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value && typeof value === 'object') {
    const total = (value as { total?: unknown }).total
    if (typeof total === 'number' && Number.isFinite(total)) return total
  }
  return 0
}

function sumXSignalCounts(counts: Record<string, unknown>): number {
  return Object.values(counts).reduce<number>((sum, value) => sum + readXSignalCountValue(value), 0)
}

function openRetryDb(dbPath: string) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_retry_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      triggered_at TEXT NOT NULL,
      result TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_source_retry_log_source_triggered
      ON source_retry_log(source_id, triggered_at DESC);
  `)
  return db
}

function countRecentRetries(db: DatabaseSync, sourceId: string, sinceIso: string) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM source_retry_log
    WHERE source_id = ?
      AND triggered_at >= ?
      AND result IN ('triggered', 'failed')
  `).get(sourceId, sinceIso) as { count: number } | undefined
  return row?.count ?? 0
}

function logRetry(db: DatabaseSync, sourceId: string, triggeredAt: string, result: RetryResult['result']) {
  db.prepare(`
    INSERT INTO source_retry_log (source_id, triggered_at, result)
    VALUES (?, ?, ?)
  `).run(sourceId, triggeredAt, result)
}

async function defaultRunLaunchd(label: string) {
  await execFileAsync('launchctl', ['start', label])
}

async function defaultRunZaraRefresh() {
  const items = await scrapeZaraYoutubeLibrary()
  createZaraStore().upsertItems(items)
}

export function createSourceRegistry(options: SourceRegistryOptions = {}): SourceDescriptor[] {
  const now = options.now ?? (() => new Date())
  const hotboardDbPath = resolveHotboardDbPath(options.hotboardDbPath)
  const xSignalLatestPath = resolveXSignalLatestPath(options.xSignalLatestPath)
  return [
    {
      id: 'zara-youtube',
      displayName: '\u5c0f\u7ea2\u4e66 Zara',
      kind: 'scheduler',
      trigger: 'in-process scheduler 1h',
      getHealth: async () => readSqliteHealth({
        dbPath: options.zaraDbPath ?? path.join(os.homedir(), '.hermes', 'data', 'hotboard-zara.sqlite'),
        tableName: 'zara_youtube_items',
        timestampColumn: 'last_refreshed_at',
        intervalMs: ZARA_INTERVAL_MS,
        nowMs: now().getTime(),
      }),
    },
    {
      id: 'x-signal',
      displayName: 'X bookmarks',
      kind: 'launchd',
      trigger: `launchd ${X_SIGNAL_LAUNCHD_LABEL} 6h`,
      getHealth: async () => readXSignalHealth(xSignalLatestPath, now().getTime()),
    },
    {
      id: 'wechat-articles',
      displayName: '\u516c\u4f17\u53f7',
      kind: 'manual',
      trigger: 'owner manual',
      getHealth: async () => readSqliteHealth({
        dbPath: hotboardDbPath,
        tableName: 'wechat_articles',
        timestampColumn: 'fetched_at',
        intervalMs: MANUAL_INTERVAL_MS,
        nowMs: now().getTime(),
      }),
    },
    {
      id: 'jc-conversations',
      displayName: 'JC\u7684\u4eba\u7c7b\u5bf9\u8c08',
      kind: 'manual',
      trigger: 'owner manual',
      getHealth: async () => ({
        last_success_at: null,
        last_failure_at: null,
        last_failure_reason: '\u73b0\u72b6: JC \u624b\u6311',
        count: 0,
        status: 'yellow',
      }),
    },
  ]
}

export async function listSourceHealth(options: SourceRegistryOptions = {}): Promise<SourceHealthEntry[]> {
  const descriptors = createSourceRegistry(options)
  return Promise.all(descriptors.map(async (source) => ({
    id: source.id,
    displayName: source.displayName,
    kind: source.kind,
    trigger: source.trigger,
    ...(await source.getHealth()),
  })))
}

export async function retrySource(sourceId: string, options: SourceRegistryOptions = {}): Promise<RetryResult> {
  const now = options.now ?? (() => new Date())
  const triggeredAt = now().toISOString()
  const hotboardDbPath = resolveHotboardDbPath(options.hotboardDbPath)
  const db = openRetryDb(hotboardDbPath)

  try {
    const sinceIso = new Date(now().getTime() - RETRY_WINDOW_MS).toISOString()
    if (countRecentRetries(db, sourceId, sinceIso) >= RETRY_LIMIT) {
      logRetry(db, sourceId, triggeredAt, 'skipped-rate-limit')
      return { source_id: sourceId, triggered_at: triggeredAt, result: 'skipped-rate-limit' }
    }

    try {
      if (sourceId === 'x-signal') {
        await (options.runLaunchd ?? defaultRunLaunchd)(X_SIGNAL_LAUNCHD_LABEL)
      } else if (sourceId === 'zara-youtube') {
        await (options.runZaraRefresh ?? defaultRunZaraRefresh)()
      } else {
        logRetry(db, sourceId, triggeredAt, 'skipped-no-trigger')
        return { source_id: sourceId, triggered_at: triggeredAt, result: 'skipped-no-trigger' }
      }

      logRetry(db, sourceId, triggeredAt, 'triggered')
      return { source_id: sourceId, triggered_at: triggeredAt, result: 'triggered' }
    } catch (error) {
      logRetry(db, sourceId, triggeredAt, 'failed')
      return {
        source_id: sourceId,
        triggered_at: triggeredAt,
        result: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  } finally {
    db.close()
  }
}

export async function retryRedSources(options: SourceRegistryOptions = {}) {
  const health = await listSourceHealth(options)
  const redSources = health.filter((source) => source.status === 'red')
  const retryResults = await Promise.all(redSources.map((source) => retrySource(source.id, options)))
  return { sources: health, retries: retryResults }
}
