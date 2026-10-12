import { describe, expect, it } from 'vitest'
import { LatestRequest } from '../../src/renderer/lib/latestRequest'

describe('LatestRequest', () => {
  it('applies an answer only while its request is the newest', () => {
    const latest = new LatestRequest()
    const first = latest.start()
    expect(first()).toBe(true)
    const second = latest.start()
    expect([first(), second()]).toEqual([false, true])
  })

  it('ignores a count that resolves after an edit or a cancel', async () => {
    const latest = new LatestRequest()
    const shown: number[] = []
    const ask = (answer: Promise<number>): Promise<void> => {
      const current = latest.start()
      return answer.then((total) => {
        if (current()) shown.push(total)
      })
    }
    let resolve!: (n: number) => void
    const pending = ask(new Promise<number>((r) => (resolve = r)))
    latest.drop() // the user edits the string while OpenAlex answers
    resolve(787)
    await pending
    expect(shown).toEqual([])
    await ask(Promise.resolve(42))
    expect(shown).toEqual([42])
  })
})
