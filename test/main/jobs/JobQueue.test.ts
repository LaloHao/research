import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { IndexCache, type TrashRow } from '../../../src/main/cache/IndexCache'
import { JobQueue, type JobHandler } from '../../../src/main/jobs/JobQueue'
import type { JobSpec } from '../../../src/shared/jobs'
import { tmpDir } from '../../helpers/tmp'

const spec = (input: string): JobSpec => ({ type: 'ingest_identifier', input })

async function cache(): Promise<IndexCache> {
  return IndexCache.open(join(await tmpDir(), 'index.sqlite'))
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('JobQueue', () => {
  it('runs jobs with bounded concurrency and records results', async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>()
    let running = 0
    let maxRunning = 0
    const handler: JobHandler = async (s) => {
      const input = (s as { input: string }).input
      running++
      maxRunning = Math.max(maxRunning, running)
      const gate = deferred()
      gates.set(input, gate)
      await gate.promise
      running--
      return { paperId: `p${input}`, message: 'added' }
    }
    const queue = new JobQueue(await cache(), handler, 2)
    queue.start()
    for (const i of ['1', '2', '3']) queue.enqueue(spec(i))
    await new Promise((r) => setTimeout(r, 10))
    expect(running).toBe(2)
    gates.get('1')!.resolve()
    await new Promise((r) => setTimeout(r, 10))
    gates.get('2')!.resolve()
    gates.get('3')!.resolve()
    await queue.whenIdle()
    expect(maxRunning).toBe(2)
    expect(queue.list().map((j) => [j.state, j.paperId, j.message])).toEqual([
      ['done', 'p3', 'added'],
      ['done', 'p2', 'added'],
      ['done', 'p1', 'added']
    ])
  })

  it('records failures with the error message', async () => {
    const queue = new JobQueue(await cache(), async () => {
      throw new Error('not_found')
    })
    queue.start()
    queue.enqueue(spec('x'))
    await queue.whenIdle()
    expect(queue.list()[0]).toMatchObject({ state: 'failed', message: 'not_found' })
  })

  it('cancels queued and running jobs', async () => {
    const handler: JobHandler = (_s, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
    const queue = new JobQueue(await cache(), handler, 1)
    queue.start()
    const running = queue.enqueue(spec('a'))
    const queued = queue.enqueue(spec('b'))
    queue.cancel(queued)
    queue.cancel(running)
    await queue.whenIdle()
    const states = Object.fromEntries(queue.list().map((j) => [j.id, j.state]))
    expect(states).toEqual({ [running]: 'cancelled', [queued]: 'cancelled' })
  })

  it('resumes jobs left running by a previous session', async () => {
    const c = await cache()
    const id = c.insertJob(JSON.stringify(spec('left')), 't0')
    c.updateJob(id, { state: 'running' }, 't0')
    const seen: string[] = []
    const queue = new JobQueue(c, async (s) => {
      seen.push((s as { input: string }).input)
      return {}
    })
    queue.start()
    await queue.whenIdle()
    expect(seen).toEqual(['left'])
  })

  it('stop() puts running jobs back in the queue for the next session', async () => {
    const c = await cache()
    const handler: JobHandler = (_s, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
    const first = new JobQueue(c, handler, 1)
    first.start()
    const id = first.enqueue(spec('a'))
    first.enqueue(spec('b'))
    await first.stop()
    expect(c.getJob(id)?.state).toBe('queued')
    const seen: string[] = []
    const second = new JobQueue(c, async (s) => {
      seen.push((s as { input: string }).input)
      return {}
    })
    second.start()
    await second.whenIdle()
    expect(seen).toEqual(['a', 'b'])
  })

  it('notifies listeners on every change', async () => {
    const queue = new JobQueue(await cache(), async () => ({}))
    let changes = 0
    const off = queue.onChange(() => changes++)
    queue.start()
    queue.enqueue(spec('x'))
    await queue.whenIdle()
    off()
    expect(changes).toBeGreaterThanOrEqual(3)
  })

  it('never runs a job of a paper in the trash, even one queued before it got there', async () => {
    const c = await cache()
    const ran: string[] = []
    const queue = new JobQueue(c, async (s) => {
      ran.push(`${s.type}:${'paperId' in s ? s.paperId : ''}`)
      return {}
    })
    const row: TrashRow = { id: 'a1', title: 'A', authors_label: '', year: null, doi: null, openalex_id: null, trashed_at: null, device: null, problem: null }
    const trashed = queue.enqueue({ type: 'summarize', paperId: 'a1' })
    const other = queue.enqueue({ type: 'citations', paperId: 'b1' })
    c.moveToTrash(row)
    queue.start()
    await queue.whenIdle()
    expect(ran).toEqual(['citations:b1'])
    expect(queue.list().find((j) => j.id === trashed)?.state).toBe('cancelled')
    expect(queue.list().find((j) => j.id === other)?.state).toBe('done')
    expect(queue.cancelQueuedPapers(['b1'])).toBe(0)
  })

  it('cancels the queued and running jobs of some papers and waits for the running ones to stop', async () => {
    const gate = deferred()
    let aborted = false
    const handler: JobHandler = async (s, signal) => {
      if (s.type === 'summarize') {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => {
            aborted = true
            resolve()
          })
        )
        throw new Error('aborted')
      }
      await gate.promise
      return {}
    }
    const queue = new JobQueue(await cache(), handler, { total: 1 })
    queue.start()
    const running = queue.enqueue({ type: 'summarize', paperId: 'a1' })
    const queuedSame = queue.enqueue({ type: 'citations', paperId: 'a1' })
    const other = queue.enqueue({ type: 'citations', paperId: 'b1' })
    await new Promise((r) => setTimeout(r, 10))
    expect(await queue.cancelPapers(['a1'])).toBe(2)
    expect(aborted).toBe(true)
    const state = (id: number) => queue.list().find((j) => j.id === id)?.state
    expect(state(running)).toBe('cancelled')
    expect(state(queuedSame)).toBe('cancelled')
    expect(['queued', 'running']).toContain(state(other))
    gate.resolve()
    await queue.whenIdle()
    expect(state(other)).toBe('done')
  })

  it('whenDone gives the finished job, or null while it still runs after the wait', async () => {
    const gate = deferred()
    const handler: JobHandler = async (s) => {
      if ((s as { input: string }).input === 'slow') await gate.promise
      return { paperId: 'p1', message: 'added' }
    }
    const queue = new JobQueue(await cache(), handler, 2)
    queue.start()
    const fast = queue.enqueue(spec('fast'))
    expect(await queue.whenDone(fast, 1000)).toMatchObject({ id: fast, state: 'done', paperId: 'p1', message: 'added' })
    expect(await queue.whenDone(fast, 0)).toMatchObject({ state: 'done' })
    const slow = queue.enqueue(spec('slow'))
    expect(await queue.whenDone(slow, 30)).toBeNull()
    const waiting = queue.whenDone(slow, 1000)
    gate.resolve()
    expect(await waiting).toMatchObject({ state: 'done' })
    const started = Date.now()
    expect(await queue.whenDone(9999, 5000)).toBeNull()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('whenDone gives a queued job once it is cancelled', async () => {
    const gate = deferred()
    const queue = new JobQueue(await cache(), async () => {
      await gate.promise
      return {}
    }, 1)
    queue.start()
    queue.enqueue(spec('first'))
    const queued = queue.enqueue(spec('second'))
    const waiting = queue.whenDone(queued, 5000)
    queue.cancel(queued)
    expect(await waiting).toMatchObject({ id: queued, state: 'cancelled' })
    gate.resolve()
    await queue.whenIdle()
  })
})

describe('JobQueue limits by type', () => {
  it('runs one summary at a time while ingests keep their own slots', async () => {
    const running: Record<string, number> = {}
    const peak: Record<string, number> = {}
    const gates: (() => void)[] = []
    const handler: JobHandler = async (s) => {
      running[s.type] = (running[s.type] ?? 0) + 1
      peak[s.type] = Math.max(peak[s.type] ?? 0, running[s.type])
      await new Promise<void>((r) => gates.push(r))
      running[s.type]--
      return {}
    }
    const queue = new JobQueue(await cache(), handler, { total: 3, byType: { summarize: 1 } })
    queue.start()
    for (const id of ['a', 'b', 'c']) queue.enqueue({ type: 'summarize', paperId: id })
    queue.enqueue({ type: 'ingest_identifier', input: 'x' })
    queue.enqueue({ type: 'ingest_identifier', input: 'y' })
    await new Promise((r) => setTimeout(r, 20))
    expect(running).toEqual({ summarize: 1, ingest_identifier: 2 })
    while (gates.length) {
      gates.shift()!()
      await new Promise((r) => setTimeout(r, 10))
    }
    await queue.whenIdle()
    expect(peak.summarize).toBe(1)
  })

  it('cancelBatch drops only the queued jobs of that batch', async () => {
    const c = await cache()
    const queue = new JobQueue(c, async () => ({}), 1)
    const ids = ['p1', 'p2'].map((paperId) => queue.enqueue({ type: 'summarize', paperId, batchId: 'b' }))
    const other = queue.enqueue({ type: 'summarize', paperId: 'p3' })
    expect(queue.cancelBatch('b')).toBe(2)
    expect(ids.map((id) => c.getJob(id)?.state)).toEqual(['cancelled', 'cancelled'])
    expect(c.getJob(other)?.state).toBe('queued')
  })
})

describe('JobQueue progress and cancel by type', () => {
  it('shows the progress a running job reports, then clears it', async () => {
    let release: () => void = () => {}
    const handler: JobHandler = async (_spec, _signal, report) => {
      report(0.25)
      report(0.251)
      await new Promise<void>((resolve) => (release = resolve))
      return {}
    }
    const queue = new JobQueue(await cache(), handler, 1)
    let emits = 0
    queue.onChange(() => emits++)
    queue.start()
    queue.enqueue({ type: 'model_download' })
    await new Promise((r) => setTimeout(r, 20))
    expect(queue.list()[0]).toMatchObject({ state: 'running', progress: 0.25 })
    const before = emits
    release()
    await queue.whenIdle()
    expect(queue.list()[0]).toMatchObject({ state: 'done', progress: null })
    expect(emits).toBeGreaterThan(before)
  })

  it('cancelTypes drops only the queued jobs of those types', async () => {
    const c = await cache()
    const queue = new JobQueue(c, async () => ({}), 1)
    const a = queue.enqueue({ type: 'citations', paperId: 'p1' })
    const b = queue.enqueue({ type: 'cited_by', paperId: 'p1' })
    const other = queue.enqueue({ type: 'embed', paperId: 'p1' })
    expect(queue.cancelTypes(['citations', 'cited_by'])).toBe(2)
    expect([c.getJob(a)?.state, c.getJob(b)?.state, c.getJob(other)?.state]).toEqual(['cancelled', 'cancelled', 'queued'])
  })
})
