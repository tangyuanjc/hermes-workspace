import { scrapeZaraYoutubeLibrary } from './hotboard-zara-scraper'
import { createZaraStore } from './hotboard-zara-store'

type HotboardRefresher = {
  name: string
  run: () => Promise<void>
}

type HotboardSchedulerLogger = Pick<typeof console, 'info' | 'warn' | 'error'>

type HotboardSchedulerOptions = {
  intervalMs?: number
  logger?: HotboardSchedulerLogger
  registerDefaultRefreshers?: boolean
}

type MutableSchedulerState = {
  timer: ReturnType<typeof setInterval> | null
  started: boolean
  refreshers: Map<string, HotboardRefresher>
  inFlightTick: Promise<void> | null
  signalHandlersInstalled: boolean
  shutdownHandler: (() => void) | null
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000
const HOTBOARD_SCHEDULER_KEY = '__hermes_hotboard_scheduler__' as const

declare global {
  // eslint-disable-next-line no-var
  var __hermes_hotboard_scheduler__:
    | {
        scheduler: HotboardScheduler
      }
    | undefined
}

function createDefaultLogger(): HotboardSchedulerLogger {
  return console
}

function createDefaultRefreshers(): HotboardRefresher[] {
  return [
    {
      name: 'zara',
      async run() {
        const items = await scrapeZaraYoutubeLibrary()
        createZaraStore().upsertItems(items)
      },
    },
  ]
}

export class HotboardScheduler {
  private readonly intervalMs: number
  private readonly logger: HotboardSchedulerLogger
  private readonly state: MutableSchedulerState
  private readonly tick = async () => {
    if (this.state.inFlightTick) {
      this.logger.warn('[hotboard-scheduler] previous tick still running; skipping overlap')
      return this.state.inFlightTick
    }

    const run = this.runAllRefreshers().finally(() => {
      this.state.inFlightTick = null
    })
    this.state.inFlightTick = run
    return run
  }

  constructor(options: HotboardSchedulerOptions = {}) {
    this.intervalMs = Math.max(1_000, Math.trunc(options.intervalMs ?? DEFAULT_INTERVAL_MS))
    this.logger = options.logger ?? createDefaultLogger()
    this.state = {
      timer: null,
      started: false,
      refreshers: new Map(),
      inFlightTick: null,
      signalHandlersInstalled: false,
      shutdownHandler: null,
    }

    if (options.registerDefaultRefreshers !== false) {
      for (const refresher of createDefaultRefreshers()) {
        this.register(refresher)
      }
    }
  }

  register(refresher: HotboardRefresher) {
    this.state.refreshers.set(refresher.name, refresher)
  }

  start() {
    if (this.state.started) return

    this.state.started = true
    this.installSignalHandlers()
    this.logger.info(`[hotboard-scheduler] started (interval=${this.intervalMs}ms)`)
    this.state.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)

    // Fire-and-forget so server boot is not blocked by the initial refresh.
    void this.tick()
  }

  stop() {
    if (this.state.timer) {
      clearInterval(this.state.timer)
      this.state.timer = null
    }
    this.state.started = false
  }

  private async runAllRefreshers() {
    for (const refresher of this.state.refreshers.values()) {
      try {
        await refresher.run()
        this.logger.info(`[hotboard-scheduler] refresh completed for ${refresher.name}`)
      } catch (error) {
        this.logger.error(
          `[hotboard-scheduler] refresh failed for ${refresher.name}`,
          error,
        )
      }
    }
  }

  private installSignalHandlers() {
    if (this.state.signalHandlersInstalled) return

    const shutdown = () => {
      this.stop()
    }

    this.state.shutdownHandler = shutdown
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
    this.state.signalHandlersInstalled = true
  }

  resetForTests() {
    this.stop()

    if (this.state.shutdownHandler) {
      process.off('SIGTERM', this.state.shutdownHandler)
      process.off('SIGINT', this.state.shutdownHandler)
      this.state.shutdownHandler = null
    }

    this.state.signalHandlersInstalled = false
    this.state.refreshers.clear()
    this.state.inFlightTick = null
  }
}

export function createHotboardScheduler(options: HotboardSchedulerOptions = {}) {
  return new HotboardScheduler(options)
}

export function startHotboardScheduler(options: HotboardSchedulerOptions = {}) {
  const existing = globalThis[HOTBOARD_SCHEDULER_KEY]?.scheduler
  if (existing) {
    existing.start()
    return existing
  }

  const scheduler = createHotboardScheduler(options)
  globalThis[HOTBOARD_SCHEDULER_KEY] = { scheduler }
  scheduler.start()
  return scheduler
}

export function stopHotboardScheduler() {
  const scheduler = globalThis[HOTBOARD_SCHEDULER_KEY]?.scheduler
  if (!scheduler) return

  scheduler.stop()
}

export function registerHotboardRefresher(refresher: HotboardRefresher) {
  let scheduler = globalThis[HOTBOARD_SCHEDULER_KEY]?.scheduler
  if (!scheduler) {
    scheduler = createHotboardScheduler({ registerDefaultRefreshers: false })
    globalThis[HOTBOARD_SCHEDULER_KEY] = { scheduler }
  }

  scheduler.register(refresher)
  return scheduler
}

export function __resetHotboardSchedulerForTests() {
  const scheduler = globalThis[HOTBOARD_SCHEDULER_KEY]?.scheduler
  scheduler?.resetForTests()
  delete globalThis[HOTBOARD_SCHEDULER_KEY]
}
