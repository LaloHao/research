import { describe, expect, it, vi } from 'vitest'
import { confirmClose, createQuitFlow, once, type CloseSteps, type QuitDeps } from '../../src/main/closeFlow'

/** A `confirmLeave`/`shutdown` pair whose resolution the test drives by hand, plus call counters. */
function deferredQuitDeps(): {
  deps: QuitDeps
  calls: string[]
  resolveLeave(ok: boolean): void
  resolveShutdown(error?: Error): void
} {
  const calls: string[] = []
  let resolveLeave: (ok: boolean) => void = () => {}
  let resolveShutdown: (error?: Error) => void = () => {}
  const deps: QuitDeps = {
    confirmLeave: () => {
      calls.push('confirmLeave')
      return new Promise((resolve) => {
        resolveLeave = resolve
      })
    },
    shutdown: () =>
      new Promise((resolve, reject) => {
        resolveShutdown = (error) => (error ? reject(error) : resolve())
      }),
    quit: () => calls.push('quit')
  }
  return {
    deps,
    calls,
    resolveLeave: (ok) => resolveLeave(ok),
    resolveShutdown: (error) => resolveShutdown(error)
  }
}

/** Waits a tick so queued promise continuations (but not a still-pending one) have run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function steps(over: Partial<CloseSteps> = {}): { calls: string[]; steps: CloseSteps } {
  const calls: string[] = []
  return {
    calls,
    steps: {
      flush: async () => {
        calls.push('flush')
        return true
      },
      unsynced: async () => {
        calls.push('unsynced')
        return false
      },
      ask: async () => {
        calls.push('ask')
        return 'close'
      },
      ...over
    }
  }
}

describe('confirmClose', () => {
  it('closes right away when everything is synced, after saving pending edits', async () => {
    const { calls, steps: s } = steps()
    expect(await confirmClose(s)).toBe(true)
    expect(calls).toEqual(['flush', 'unsynced'])
  })

  it('asks when something is not synced, and closes or stays as answered', async () => {
    const unsynced = async (): Promise<boolean> => true
    expect(await confirmClose(steps({ unsynced, ask: async () => 'close' }).steps)).toBe(true)
    expect(await confirmClose(steps({ unsynced, ask: async () => 'cancel' }).steps)).toBe(false)
  })

  it('closes when the sync status cannot be read', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { calls, steps: s } = steps({ unsynced: async () => Promise.reject(new Error('git broke')) })
    expect(await confirmClose(s)).toBe(true)
    expect(calls).toEqual(['flush'])
    spy.mockRestore()
  })

  it('closes without asking when the renderer did not answer the flush', async () => {
    const calls: string[] = []
    const s: CloseSteps = {
      flush: async () => {
        calls.push('flush')
        return false
      },
      unsynced: async () => {
        calls.push('unsynced')
        return true
      },
      ask: async () => {
        calls.push('ask')
        return 'cancel'
      }
    }
    expect(await confirmClose(s)).toBe(true)
    expect(calls).toEqual(['flush'])
  })
})

describe('once', () => {
  it('joins a call already in flight instead of starting another', async () => {
    let starts = 0
    let release: () => void = () => {}
    const run = once(async () => {
      starts += 1
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return starts
    })
    const first = run()
    const second = run()
    release()
    expect(await first).toBe(1)
    expect(await second).toBe(1)
    expect(starts).toBe(1)
  })

  it('starts a fresh call once the previous one settled', async () => {
    let starts = 0
    const run = once(async () => {
      starts += 1
      return starts
    })
    expect(await run()).toBe(1)
    expect(await run()).toBe(2)
  })
})

describe('createQuitFlow', () => {
  it('two quit requests racing during the prompt: only the first drives confirm + shutdown, and quit() happens once, after shutdown finishes', async () => {
    const { deps, calls, resolveLeave, resolveShutdown } = deferredQuitDeps()
    const flow = createQuitFlow(deps)

    expect(flow.beforeQuit()).toBe(true) // first arrival: starts the chain, must preventDefault
    expect(flow.beforeQuit()).toBe(true) // second arrival while confirming: joins, must also preventDefault
    expect(calls).toEqual(['confirmLeave']) // only one confirmLeave() call, not two

    resolveLeave(true)
    await tick()
    expect(flow.beforeQuit()).toBe(true) // a third arrival while shutting down: still joins
    expect(calls).toEqual(['confirmLeave']) // shutdown() is in flight, not yet settled, so no quit() yet

    resolveShutdown()
    await tick()
    expect(calls).toEqual(['confirmLeave', 'quit']) // quit() called exactly once, after shutdown resolved
  })

  it('Important 2: a failing shutdown still lets the app quit', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { deps, calls, resolveLeave, resolveShutdown } = deferredQuitDeps()
    const flow = createQuitFlow(deps)

    flow.beforeQuit()
    resolveLeave(true)
    await tick()
    resolveShutdown(new Error('cache.close() failed'))
    await tick()

    expect(calls).toEqual(['confirmLeave', 'quit'])
    spy.mockRestore()
  })

  it('Important 1: leaving is confirmed only once confirmLeave() resolves true, not merely because a quit was requested', async () => {
    const { deps, resolveLeave, resolveShutdown } = deferredQuitDeps()
    const flow = createQuitFlow(deps)

    flow.beforeQuit()
    expect(flow.isLeavingConfirmed()).toBe(false) // the prompt is still open: ✕ must still join it, not skip it

    resolveLeave(true)
    await tick()
    expect(flow.isLeavingConfirmed()).toBe(true) // the user (or a flush-ack-less renderer) allowed leaving

    resolveShutdown()
    await tick()
  })

  it('a cancelled quit never confirms leaving or calls quit(), and a later quit can ask again', async () => {
    const { deps, calls, resolveLeave } = deferredQuitDeps()
    const flow = createQuitFlow(deps)

    flow.beforeQuit()
    resolveLeave(false)
    await tick()
    expect(flow.isLeavingConfirmed()).toBe(false)
    expect(calls).toEqual(['confirmLeave'])

    flow.beforeQuit() // a fresh chain: confirmLeave() is called again, not skipped
    expect(calls).toEqual(['confirmLeave', 'confirmLeave'])
  })

  it('a later before-quit (or window-all-closed quitting again) lets the native quit through once shut down', async () => {
    const { deps, calls, resolveLeave, resolveShutdown } = deferredQuitDeps()
    const flow = createQuitFlow(deps)

    flow.beforeQuit()
    resolveLeave(true)
    await tick()
    resolveShutdown()
    await tick()
    expect(calls).toEqual(['confirmLeave', 'quit'])

    expect(flow.beforeQuit()).toBe(false) // already shut down: no preventDefault, let it quit for real
    expect(calls).toEqual(['confirmLeave', 'quit']) // quit() is not called again
  })
})
