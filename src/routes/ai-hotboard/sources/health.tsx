import { createFileRoute, Link } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePrepareAiHotboardPage } from '../../ai-hotboard'
import { cn } from '@/lib/utils'
import { useAiHotboardAuth } from '@/screens/ai-hotboard/ai-hotboard-auth'
import { canAccessOwnerHotboardPanels } from '@/screens/ai-hotboard/ai-hotboard-screen'

type SourceHealthStatus = 'green' | 'yellow' | 'red'

type OwnerSourceHealthEntry = {
  id: string
  displayName: string
  kind: 'scheduler' | 'launchd' | 'manual'
  trigger: string
  last_success_at: string | null
  last_failure_at: string | null
  last_failure_reason: string | null
  count: number
  status: SourceHealthStatus
}

type SafeSourceHealthEntry = {
  source_name: string
  status_chip: SourceHealthStatus
}

type SourceHealthEntry = OwnerSourceHealthEntry | SafeSourceHealthEntry

type HealthPayload = {
  sources: SourceHealthEntry[]
}

const STATUS_LABELS = {
  green: '正常',
  yellow: '观察',
  red: '异常',
} as const

const STATUS_DOT_CLASSES = {
  green: 'bg-emerald-400 shadow-[0_0_18px_rgba(52,211,153,0.58)]',
  yellow: 'bg-amber-300 shadow-[0_0_18px_rgba(252,211,77,0.58)]',
  red: 'bg-rose-400 shadow-[0_0_18px_rgba(251,113,133,0.58)]',
} as const

const KIND_LABELS = {
  scheduler: 'scheduler',
  launchd: 'launchd',
  manual: 'manual',
} as const

export const Route = createFileRoute('/ai-hotboard/sources/health')({
  component: SourceHealthRoute,
})

function formatRelativeTime(value: string | null) {
  if (!value) return '暂无成功记录'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value

  const diffMs = Date.now() - timestamp
  const absMs = Math.abs(diffMs)
  const suffix = diffMs >= 0 ? '前' : '后'
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour

  if (absMs < minute) return '刚刚'
  if (absMs < hour) return `${Math.round(absMs / minute)} 分钟${suffix}`
  if (absMs < day) return `${Math.round(absMs / hour)} 小时${suffix}`
  return `${Math.round(absMs / day)} 天${suffix}`
}

function isOwnerSourceHealthEntry(source: SourceHealthEntry): source is OwnerSourceHealthEntry {
  return 'id' in source
}

function getSourceStatus(source: SourceHealthEntry): SourceHealthStatus {
  return isOwnerSourceHealthEntry(source) ? source.status : source.status_chip
}

function getSourceName(source: SourceHealthEntry): string {
  return isOwnerSourceHealthEntry(source) ? source.displayName : source.source_name
}

function getSourceKey(source: SourceHealthEntry): string {
  return isOwnerSourceHealthEntry(source) ? source.id : source.source_name
}

function SourceHealthRoute() {
  usePrepareAiHotboardPage()
  const { authUser, authResolved } = useAiHotboardAuth()
  const isOwner = canAccessOwnerHotboardPanels(authUser)
  const [sources, setSources] = useState<SourceHealthEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)

  const fetchHealth = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/sources/health')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json() as HealthPayload
      setSources(payload.sources ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!authResolved) return
    void fetchHealth()
  }, [authResolved, fetchHealth])

  const statusSummary = useMemo(() => {
    return sources.reduce<Record<SourceHealthStatus, number>>((acc, source) => {
      acc[getSourceStatus(source)] += 1
      return acc
    }, { green: 0, yellow: 0, red: 0 })
  }, [sources])

  async function retryNow(sourceId: string) {
    if (!isOwner) return
    setRetryingId(sourceId)
    setError(null)
    try {
      const response = await fetch('/api/sources/health/retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source_id: sourceId }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await fetchHealth()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRetryingId(null)
    }
  }

  if (!authResolved) {
    return (
      <main className="min-h-screen bg-slate-950 px-5 py-6 text-slate-100 sm:px-8 lg:px-10">
        <section className="mx-auto max-w-6xl rounded-[28px] border border-white/10 bg-slate-900/80 p-6 text-slate-300 shadow-[0_24px_72px_rgba(2,6,23,0.52)]">
          正在检查权限...
        </section>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-slate-950 px-5 py-6 text-slate-100 sm:px-8 lg:px-10">
      <section className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="rounded-[28px] border border-white/10 bg-slate-900/80 p-6 shadow-[0_24px_72px_rgba(2,6,23,0.52)]">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="text-[11px] tracking-[0.3em] text-cyan-300/80">SOURCE HEALTH</div>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white sm:text-5xl">信源健康</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
                {isOwner
                  ? '统一观测 Zara、X、公众号和 JC 手挑对谈的触发状态、最近成功时间和记录数量。'
                  : '成员视图仅展示业务信源名与健康状态, 不暴露 source id、触发器、路径或错误细节。'}
              </p>
            </div>
            <Link to="/ai-hotboard" className="rounded-2xl border border-white/10 px-4 py-2 text-sm text-slate-200 hover:border-cyan-300/40 hover:text-white">
              返回热榜
            </Link>
          </div>
          <div className="mt-5 flex flex-wrap gap-2 text-xs text-slate-300">
            <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1">green {statusSummary.green}</span>
            <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1">yellow {statusSummary.yellow}</span>
            <span className="rounded-full border border-rose-300/20 bg-rose-300/10 px-3 py-1">red {statusSummary.red}</span>
          </div>
        </header>

        {error ? (
          <div className="rounded-2xl border border-rose-300/20 bg-rose-950/35 px-4 py-3 text-sm text-rose-100">{error}</div>
        ) : null}

        {loading ? (
          <div className="rounded-[28px] border border-white/10 bg-slate-900/75 p-6 text-slate-400">正在读取信源健康...</div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {sources.map((source) => {
              const status = getSourceStatus(source)
              const isDetailed = isOwnerSourceHealthEntry(source)

              return (
              <article key={getSourceKey(source)} className="rounded-[28px] border border-white/10 bg-slate-900/80 p-5 shadow-[0_20px_56px_rgba(2,6,23,0.42)]">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-slate-500">
                      <span className={cn('size-2.5 rounded-full', STATUS_DOT_CLASSES[status])} />
                      {STATUS_LABELS[status]}
                    </div>
                    <h2 className="mt-3 text-2xl font-semibold text-white">{getSourceName(source)}</h2>
                  </div>
                  {isDetailed ? (
                    <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs text-cyan-100">
                      {KIND_LABELS[source.kind]}
                    </span>
                  ) : null}
                </div>

                {isDetailed ? (
                  <dl className="mt-5 grid gap-3 text-sm text-slate-300 sm:grid-cols-2">
                    <div className="rounded-2xl border border-white/10 bg-slate-950/45 p-3">
                      <dt className="text-xs text-slate-500">last_success</dt>
                      <dd className="mt-1 text-base text-slate-100">{formatRelativeTime(source.last_success_at)}</dd>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-slate-950/45 p-3">
                      <dt className="text-xs text-slate-500">count</dt>
                      <dd className="mt-1 text-2xl font-semibold text-slate-100">{source.count}</dd>
                    </div>
                  </dl>
                ) : null}

                {isDetailed ? (
                  <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/45 px-3 py-2 text-xs text-slate-400">
                    {source.trigger}
                  </div>
                ) : null}
                {isDetailed && source.last_failure_reason ? (
                  <div className="mt-3 rounded-2xl border border-amber-300/15 bg-amber-300/8 px-3 py-2 text-xs text-amber-100">
                    {source.last_failure_reason}
                  </div>
                ) : null}

                {isOwner && isDetailed ? (
                  <button
                    type="button"
                    onClick={() => void retryNow(source.id)}
                    disabled={retryingId === source.id}
                    className="mt-5 rounded-2xl border border-amber-300/35 bg-amber-300/15 px-4 py-2 text-sm text-amber-50 transition hover:border-amber-200/60 hover:bg-amber-300/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {retryingId === source.id ? '重试中...' : '立即重试'}
                  </button>
                ) : null}
              </article>
              )
            })}
          </div>
        )}
      </section>
    </main>
  )
}
