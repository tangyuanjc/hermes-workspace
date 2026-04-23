import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetHotboardSchedulerForTests,
  createHotboardScheduler,
  registerHotboardRefresher,
  startHotboardScheduler,
  stopHotboardScheduler,
} from './hotboard-scheduler'

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

async function flushSchedulerTick() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('hotboard scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    __resetHotboardSchedulerForTests()
  })

  afterEach(() => {
    stopHotboardScheduler()
    __resetHotboardSchedulerForTests()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('runs registered refreshers immediately and again on each interval tick', async () => {
    const logger = createLogger()
    const refresher = vi.fn(async () => undefined)
    const scheduler = createHotboardScheduler({
      intervalMs: 1_000,
      logger,
      registerDefaultRefreshers: false,
    })

    scheduler.register({
      name: 'mock-source',
      run: refresher,
    })

    scheduler.start()
    await flushSchedulerTick()

    expect(refresher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(refresher).toHaveBeenCalledTimes(2)
  })

  it('logs refresher errors and keeps running the rest of the schedule', async () => {
    const logger = createLogger()
    const badRefresher = vi.fn(async () => {
      throw new Error('zara fetch failed')
    })
    const goodRefresher = vi.fn(async () => undefined)
    const scheduler = createHotboardScheduler({
      intervalMs: 1_000,
      logger,
      registerDefaultRefreshers: false,
    })

    scheduler.register({
      name: 'bad-source',
      run: badRefresher,
    })
    scheduler.register({
      name: 'good-source',
      run: goodRefresher,
    })

    scheduler.start()
    await flushSchedulerTick()

    expect(badRefresher).toHaveBeenCalledTimes(1)
    expect(goodRefresher).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[hotboard-scheduler] refresh failed for bad-source'),
      expect.any(Error),
    )

    await vi.advanceTimersByTimeAsync(1_000)
    expect(badRefresher).toHaveBeenCalledTimes(2)
    expect(goodRefresher).toHaveBeenCalledTimes(2)
  })

  it('reuses a single global scheduler instance across repeated start calls', async () => {
    const logger = createLogger()
    const refresher = vi.fn(async () => undefined)

    const first = startHotboardScheduler({
      intervalMs: 1_000,
      logger,
      registerDefaultRefreshers: false,
    })
    const second = startHotboardScheduler({
      intervalMs: 1_000,
      logger,
      registerDefaultRefreshers: false,
    })

    expect(first).toBe(second)
    first.register({
      name: 'singleton-source',
      run: refresher,
    })

    await vi.advanceTimersByTimeAsync(1_000)
    await flushSchedulerTick()
    expect(refresher).toHaveBeenCalledTimes(1)
  })

  it('stops future interval ticks after stopHotboardScheduler is called', async () => {
    const logger = createLogger()
    const refresher = vi.fn(async () => undefined)

    registerHotboardRefresher({
      name: 'stoppable-source',
      run: refresher,
    })

    startHotboardScheduler({
      intervalMs: 1_000,
      logger,
      registerDefaultRefreshers: false,
    })
    await flushSchedulerTick()

    expect(refresher).toHaveBeenCalledTimes(1)

    stopHotboardScheduler()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(refresher).toHaveBeenCalledTimes(1)
  })
})
