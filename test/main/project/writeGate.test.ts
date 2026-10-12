import { describe, expect, it } from 'vitest'
import { WriteGate } from '../../../src/main/project/writeGate'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

describe('WriteGate', () => {
  it('lets writes run side by side, makes an exclusive holder wait for them, and holds the writes that come after it', async () => {
    const gate = new WriteGate()
    const log: string[] = []
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const a = gate.shared(async () => {
      log.push('a start')
      await held
      log.push('a end')
    })
    const b = gate.shared(async () => void log.push('b'))
    await b
    const sync = gate.exclusive(async () => void log.push('sync'))
    const c = gate.shared(async () => void log.push('c'))
    await tick()
    expect(log).toEqual(['a start', 'b'])
    release()
    await Promise.all([a, sync, c])
    expect(log).toEqual(['a start', 'b', 'a end', 'sync', 'c'])
  })

  it('opens again after a failure, and returns what the function returns', async () => {
    const gate = new WriteGate()
    await expect(gate.exclusive(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(gate.shared(async () => Promise.reject(new Error('write failed')))).rejects.toThrow('write failed')
    expect(await gate.exclusive(async () => 42)).toBe(42)
    expect(await gate.shared(async () => 'ok')).toBe('ok')
  })
})
