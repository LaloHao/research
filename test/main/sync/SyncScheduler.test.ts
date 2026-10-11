import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncScheduler } from '../../../src/main/sync/SyncScheduler'

const MIN = 60_000

function setup() {
  const state = { enabled: true, canRun: true, interval: 10 * MIN, hold: false, finish: (): void => undefined }
  let runs = 0
  const scheduler = new SyncScheduler({
    run: () => {
      runs++
      return state.hold ? new Promise<void>((resolve) => (state.finish = resolve)) : Promise.resolve()
    },
    canRun: () => state.canRun,
    enabled: () => state.enabled,
    intervalMs: () => state.interval
  })
  return { state, scheduler, runs: () => runs }
}

describe('SyncScheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('syncs when the project opens and then every interval', async () => {
    const { scheduler, runs } = setup()
    scheduler.start()
    expect(runs()).toBe(1)
    await vi.advanceTimersByTimeAsync(10 * MIN - 1)
    expect(runs()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runs()).toBe(2)
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(runs()).toBe(3)
    await scheduler.stop()
  })

  it('skips a tick it cannot run (a decision waiting, a trash operation) and tries at the next one', async () => {
    const { state, scheduler, runs } = setup()
    state.canRun = false
    scheduler.start()
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(runs()).toBe(0)
    state.canRun = true
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(runs()).toBe(1)
    await scheduler.stop()
  })

  it('never starts a sync while one is still running; the next interval counts from its end', async () => {
    const { state, scheduler, runs } = setup()
    state.hold = true
    scheduler.start()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(runs()).toBe(1)
    state.hold = false
    state.finish()
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(runs()).toBe(2)
    await scheduler.stop()
  })

  it('does nothing while turned off, and follows a new setting from the next interval', async () => {
    const { state, scheduler, runs } = setup()
    state.enabled = false
    scheduler.start()
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(runs()).toBe(0)
    state.enabled = true
    state.interval = 5 * MIN
    scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(runs()).toBe(1)
    state.enabled = false
    scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(runs()).toBe(1)
    await scheduler.stop()
  })

  it('stops for good, waiting for the sync in progress', async () => {
    const { state, scheduler, runs } = setup()
    state.hold = true
    scheduler.start()
    let stopped = false
    const stop = scheduler.stop().then(() => (stopped = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(false)
    state.finish()
    await stop
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(runs()).toBe(1)
  })

  it('keeps going after a failed sync', async () => {
    let calls = 0
    const scheduler = new SyncScheduler({
      run: async () => {
        calls++
        throw new Error('offline')
      },
      canRun: () => true,
      enabled: () => true,
      intervalMs: () => MIN
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    scheduler.start()
    await vi.advanceTimersByTimeAsync(MIN)
    expect(calls).toBe(2)
    await scheduler.stop()
    spy.mockRestore()
  })
})
