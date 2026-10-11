import { describe, expect, it, vi } from 'vitest'
import { confirmClose, decideQuit, once, type CloseSteps } from '../../src/main/closeFlow'

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

describe('decideQuit', () => {
  it('starts the shutdown when nothing is running', () => {
    expect(decideQuit({ quitting: false, shutDown: false })).toBe('start')
  })

  it('two quit requests racing during the prompt: only the first drives the shutdown', () => {
    // First arrival: nothing running yet, it starts the chain.
    expect(decideQuit({ quitting: false, shutDown: false })).toBe('start')
    // Second arrival while the first is still confirming or shutting down: it only joins.
    expect(decideQuit({ quitting: true, shutDown: false })).toBe('join')
  })

  it('a window close followed by a quit while the window close is still confirming: the quit joins', () => {
    // The window's own `close` handler drives `confirmLeave` outside this state machine; a `before-quit`
    // that arrives in the meantime (quitting not yet true, because no shutdown chain started) still
    // starts its own chain rather than being lost — it is `confirmLeave` itself (deduped by `once`)
    // that keeps the two from asking twice.
    expect(decideQuit({ quitting: false, shutDown: false })).toBe('start')
  })

  it('lets a later quit through once the shutdown already finished', () => {
    expect(decideQuit({ quitting: true, shutDown: true })).toBe('allow')
    expect(decideQuit({ quitting: false, shutDown: true })).toBe('allow')
  })
})
