import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunClock } from '../../../src/main/llm/RunClock'

describe('RunClock', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('expires after its time, and never once disarmed', () => {
    const clock = new RunClock()
    let expired = 0
    clock.start(1000, () => expired++)
    vi.advanceTimersByTime(999)
    expect(expired).toBe(0)
    vi.advanceTimersByTime(1)
    expect(expired).toBe(1)
    const other = new RunClock()
    const disarm = other.start(1000, () => expired++)
    disarm()
    vi.advanceTimersByTime(5000)
    expect(expired).toBe(1)
  })

  it('stops while held, counting only the time it ran; holds nest and each release counts once', () => {
    const clock = new RunClock()
    let expired = false
    clock.start(1000, () => (expired = true))
    vi.advanceTimersByTime(400)
    const a = clock.hold()
    const b = clock.hold()
    vi.advanceTimersByTime(10_000)
    a()
    a()
    vi.advanceTimersByTime(10_000)
    expect(expired).toBe(false)
    b()
    vi.advanceTimersByTime(599)
    expect(expired).toBe(false)
    vi.advanceTimersByTime(1)
    expect(expired).toBe(true)
  })

  it('a hold taken before the start delays it until released', () => {
    const clock = new RunClock()
    let expired = false
    const release = clock.hold()
    clock.start(100, () => (expired = true))
    vi.advanceTimersByTime(1000)
    expect(expired).toBe(false)
    release()
    vi.advanceTimersByTime(100)
    expect(expired).toBe(true)
  })
})
