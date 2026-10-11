import { describe, expect, it } from 'vitest'
import { waitForFlush } from '../../src/main/flush'
import { flushAll, onFlush } from '../../src/renderer/lib/flush'

describe('flush before close', () => {
  it('main resolves as soon as the renderer acknowledges', async () => {
    let ack: () => void = () => {}
    let unsubscribed = false
    const start = Date.now()
    const acked = await waitForFlush(
      () => setTimeout(() => ack(), 10),
      (cb) => {
        ack = cb
        return () => (unsubscribed = true)
      },
      5000
    )
    expect(Date.now() - start).toBeLessThan(1000)
    expect(unsubscribed).toBe(true)
    expect(acked).toBe(true)
  })

  it('main gives up after the timeout when the renderer never answers', async () => {
    const start = Date.now()
    const acked = await waitForFlush(() => {}, () => () => {}, 50)
    expect(Date.now() - start).toBeGreaterThanOrEqual(45)
    expect(acked).toBe(false)
  })

  it('a send that throws counts as not acknowledged, right away', async () => {
    const acked = await waitForFlush(
      () => {
        throw new Error('renderer gone')
      },
      () => () => {},
      5000
    )
    expect(acked).toBe(false)
  })

  it('the renderer waits for every pending save, even if one fails', async () => {
    const saved: string[] = []
    const offA = onFlush(async () => {
      await new Promise((r) => setTimeout(r, 20))
      saved.push('a')
    })
    const offB = onFlush(async () => {
      throw new Error('disk full')
    })
    await flushAll()
    expect(saved).toEqual(['a'])
    offA()
    offB()
    await flushAll()
    expect(saved).toEqual(['a'])
  })
})
