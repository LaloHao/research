import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalGate, type ApprovalOutcome } from '../../../src/main/chats/ApprovalGate'
import { RunClock } from '../../../src/main/llm/RunClock'

const request = {
  tool: 'trash_papers' as const,
  args: { paper_ids: ['he2017drain'] },
  preview: { papers: [{ id: 'he2017drain', title: 'Drain' }], cost: null },
  request: null,
  risk: 'removes' as const,
  pickPdf: false
}
const pdfRequest = { ...request, tool: 'attach_pdf' as const, args: { paper_id: 'he2017drain' }, risk: 'file' as const, pickPdf: true }
const AT = new Date('2026-10-12T10:00:00.000Z')

describe('ApprovalGate', () => {
  afterEach(() => vi.useRealTimers())

  it('waits for the decision of its own conversation, lists what waits and says when that changes', async () => {
    const changed: string[] = []
    const gate = new ApprovalGate({ timeoutMs: 60_000, changed: (id) => changed.push(id), now: () => AT })
    const answer = gate.ask('c1', request, new AbortController().signal)
    const [pending] = gate.pending('c1')
    expect(pending).toMatchObject({ tool: 'trash_papers', risk: 'removes', expiresAt: '2026-10-12T10:01:00.000Z' })
    expect(pending.id).toMatch(/^[0-9a-f]{6}$/)
    expect(gate.get('c1', pending.id)).toEqual(pending)
    expect(gate.get('c2', pending.id)).toBeNull()
    expect(gate.pending('c2')).toEqual([])
    expect(gate.decide('c2', pending.id, { approve: true })).toBe(false)
    expect(gate.pending('c1')).toHaveLength(1)
    expect(gate.decide('c1', pending.id, { approve: true, pdfPath: '/tmp/x.pdf' })).toBe(true)
    // Only an approval that picks a PDF passes a path on.
    expect(await answer).toEqual({ kind: 'approved' })
    expect(gate.pending('c1')).toEqual([])
    expect(gate.get('c1', pending.id)).toBeNull()
    expect(gate.decide('c1', pending.id, { approve: false })).toBe(false)
    expect(changed).toEqual(['c1', 'c1'])
  })

  it('passes on the PDF the user picked, and never approves a picker approval without one', async () => {
    const gate = new ApprovalGate({ timeoutMs: 60_000, changed: () => undefined })
    const answer = gate.ask('c1', pdfRequest, new AbortController().signal)
    const id = gate.pending('c1')[0].id
    expect(gate.decide('c1', id, { approve: true })).toBe(false)
    expect(gate.decide('c1', id, { approve: true, pdfPath: '' })).toBe(false)
    expect(gate.decide('c1', id, { approve: true, pdfPath: 42 as unknown as string })).toBe(false)
    expect(gate.pending('c1')).toHaveLength(1)
    expect(gate.decide('c1', id, { approve: true, pdfPath: '/home/me/drain.pdf' })).toBe(true)
    expect(await answer).toEqual({ kind: 'approved', pdfPath: '/home/me/drain.pdf' })
  })

  it('counts as denied when the user says no, at the timeout, when stopped and when switched off', async () => {
    const gate = new ApprovalGate({ timeoutMs: 40, changed: () => undefined })
    const user = gate.ask('c1', request, new AbortController().signal)
    gate.decide('c1', gate.pending('c1')[0].id, { approve: false })
    expect(await user).toEqual({ kind: 'denied', reason: 'user' })
    expect(await gate.ask('c1', request, new AbortController().signal)).toEqual({ kind: 'denied', reason: 'timeout' })
    const ac = new AbortController()
    const stopped = gate.ask('c1', request, ac.signal)
    ac.abort()
    expect(await stopped).toEqual({ kind: 'denied', reason: 'stopped' })
    expect(await gate.ask('c1', request, ac.signal)).toEqual({ kind: 'denied', reason: 'stopped' })
    const off = gate.ask('c1', request, new AbortController().signal)
    gate.denyWhere('c1', (a) => a.tool === 'trash_papers', 'disabled')
    expect(await off).toEqual({ kind: 'denied', reason: 'disabled' })
    expect(gate.pending('c1')).toEqual([])
  })

  it('denies only what matches, in the conversation named, and everything when the project closes', async () => {
    const gate = new ApprovalGate({ timeoutMs: 60_000, changed: () => undefined })
    const sync = gate.ask('c1', { ...request, tool: 'sync_now', args: {}, risk: 'sync' }, new AbortController().signal)
    const trash = gate.ask('c1', request, new AbortController().signal)
    const other = gate.ask('c2', { ...request, tool: 'sync_now', args: {}, risk: 'sync' }, new AbortController().signal)
    gate.denyWhere('c1', (a) => a.tool === 'sync_now', 'disabled')
    expect(await sync).toEqual({ kind: 'denied', reason: 'disabled' })
    expect(gate.pending('c1').map((a) => a.tool)).toEqual(['trash_papers'])
    expect(gate.pending('c2')).toHaveLength(1)
    gate.denyAll('stopped')
    expect(await trash).toEqual({ kind: 'denied', reason: 'stopped' })
    expect(await other).toEqual({ kind: 'denied', reason: 'stopped' })
    expect(gate.pending('c1')).toEqual([])
    expect(gate.pending('c2')).toEqual([])
  })

  it('settles each approval exactly once, whatever comes after', async () => {
    vi.useFakeTimers()
    const changed: string[] = []
    const gate = new ApprovalGate({ timeoutMs: 1000, changed: (id) => changed.push(id) })
    const ac = new AbortController()
    const outcomes: ApprovalOutcome[] = []
    void gate.ask('c1', request, ac.signal).then((o) => outcomes.push(o))
    const id = gate.pending('c1')[0].id
    expect(gate.decide('c1', id, { approve: false })).toBe(true)
    expect(gate.decide('c1', id, { approve: true })).toBe(false)
    ac.abort()
    gate.denyWhere('c1', () => true, 'disabled')
    gate.denyAll('stopped')
    await vi.advanceTimersByTimeAsync(5000)
    expect(outcomes).toEqual([{ kind: 'denied', reason: 'user' }])
    expect(changed).toEqual(['c1', 'c1'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a decision that comes after the timeout finds nothing', async () => {
    vi.useFakeTimers()
    const gate = new ApprovalGate({ timeoutMs: 1000, changed: () => undefined })
    const answer = gate.ask('c1', request, new AbortController().signal)
    const id = gate.pending('c1')[0].id
    await vi.advanceTimersByTimeAsync(1000)
    expect(gate.decide('c1', id, { approve: true })).toBe(false)
    expect(await answer).toEqual({ kind: 'denied', reason: 'timeout' })
  })

  it('asks nothing for an answer already stopped', async () => {
    const changed: string[] = []
    const gate = new ApprovalGate({ timeoutMs: 1000, changed: (id) => changed.push(id) })
    const ac = new AbortController()
    ac.abort()
    const clock = new RunClock()
    const hold = vi.spyOn(clock, 'hold')
    expect(await gate.ask('c1', request, ac.signal, clock)).toEqual({ kind: 'denied', reason: 'stopped' })
    expect(gate.pending('c1')).toEqual([])
    expect(changed).toEqual([])
    expect(hold).not.toHaveBeenCalled()
  })

  it('keeps what the user approves apart from what the caller does with its request afterwards', async () => {
    const gate = new ApprovalGate({ timeoutMs: 60_000, changed: () => undefined })
    const mine = structuredClone(request)
    void gate.ask('c1', mine, new AbortController().signal)
    mine.args.paper_ids.push('everything')
    mine.preview.papers.length = 0
    const [pending] = gate.pending('c1')
    expect(pending.args).toEqual({ paper_ids: ['he2017drain'] })
    expect(pending.preview.papers).toHaveLength(1)
    expect(() => (pending.args.paper_ids as string[]).push('x')).toThrow()
    expect(() => ((pending as { pickPdf: boolean }).pickPdf = true)).toThrow()
    expect(() => ((pending as { id: string }).id = 'abcdef')).toThrow()
    gate.denyAll('stopped')
  })

  it('gives every waiting approval its own id', () => {
    const gate = new ApprovalGate({ timeoutMs: 60_000, changed: () => undefined })
    for (let i = 0; i < 200; i++) void gate.ask(i % 2 ? 'c1' : 'c2', request, new AbortController().signal)
    const ids = [...gate.pending('c1'), ...gate.pending('c2')].map((a) => a.id)
    expect(new Set(ids).size).toBe(200)
    gate.denyAll('stopped')
  })

  it('still settles when the change listener throws', async () => {
    const gate = new ApprovalGate({
      timeoutMs: 60_000,
      changed: () => {
        throw new Error('listener')
      }
    })
    const answer = gate.ask('c1', request, new AbortController().signal)
    expect(gate.decide('c1', gate.pending('c1')[0].id, { approve: false })).toBe(true)
    expect(await answer).toEqual({ kind: 'denied', reason: 'user' })
  })

  it("holds the answer's clock while it waits", async () => {
    vi.useFakeTimers()
    const clock = new RunClock()
    let expired = false
    clock.start(1000, () => (expired = true))
    const gate = new ApprovalGate({ timeoutMs: 5000, changed: () => undefined })
    const answer = gate.ask('c1', request, new AbortController().signal, clock)
    await vi.advanceTimersByTimeAsync(4999)
    expect(expired).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await answer).toEqual({ kind: 'denied', reason: 'timeout' })
    await vi.advanceTimersByTimeAsync(999)
    expect(expired).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(expired).toBe(true)
  })

  it('releases the clock once whichever way it settles, and only when the last of several approvals settles', async () => {
    vi.useFakeTimers()
    const clock = new RunClock()
    let expired = false
    clock.start(1000, () => (expired = true))
    const gate = new ApprovalGate({ timeoutMs: 60_000, changed: () => undefined })
    const ac = new AbortController()
    const a = gate.ask('c1', request, ac.signal, clock)
    const b = gate.ask('c1', request, new AbortController().signal, clock)
    ac.abort()
    expect(await a).toEqual({ kind: 'denied', reason: 'stopped' })
    gate.denyWhere('c1', () => true, 'disabled')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(expired).toBe(true)
    expect(await b).toEqual({ kind: 'denied', reason: 'disabled' })

    const clock2 = new RunClock()
    let expired2 = false
    clock2.start(1000, () => (expired2 = true))
    const c = gate.ask('c1', request, new AbortController().signal, clock2)
    const d = gate.ask('c1', request, new AbortController().signal, clock2)
    const [first] = gate.pending('c1')
    gate.decide('c1', first.id, { approve: false })
    await c
    await vi.advanceTimersByTimeAsync(10_000)
    expect(expired2).toBe(false)
    gate.denyAll('stopped')
    await d
    await vi.advanceTimersByTimeAsync(999)
    expect(expired2).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(expired2).toBe(true)
  })
})
