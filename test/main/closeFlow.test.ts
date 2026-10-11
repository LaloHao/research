import { describe, expect, it, vi } from 'vitest'
import { confirmClose, type CloseSteps } from '../../src/main/closeFlow'

function steps(over: Partial<CloseSteps> = {}): { calls: string[]; steps: CloseSteps } {
  const calls: string[] = []
  return {
    calls,
    steps: {
      flush: async () => void calls.push('flush'),
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
})
