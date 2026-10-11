import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { samplePaper } from '../../helpers/papers'
import { tmpDir } from '../../helpers/tmp'

const ID = 'he2017drain'
const DEVICE = '22222222-2222-2222-2222-222222222222'
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('ProjectStore write gate', () => {
  it('holds every write while the sync has the folder, and runs them once it lets go', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    await store.writePaper(samplePaper(), null)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const sync = store.exclusive(() => held)
    const done: string[] = []
    const writes = [
      store.writeNotes(ID, 'late notes', null).then(() => done.push('notes')),
      store.appendCost(DEVICE, { at: '2026-10-11T00:00:00.000Z', paper_id: ID, batch_id: null, model: 'sonnet', cost_usd: 0.1, operation: 'summarize' }).then(() => done.push('cost')),
      store.updateConfig({ name: 'Renamed' }).then(() => done.push('config')),
      store.writeRelations({ schema_version: 1, relations: [], analyzed: {} }, null).then(() => done.push('relations'))
    ]
    await tick()
    expect(done).toEqual([])
    expect(existsSync(join(store.paperDir(ID), 'notes.md'))).toBe(false)
    expect(existsSync(join(store.root, 'costs'))).toBe(false)
    release()
    await sync
    await Promise.all(writes)
    expect(done.sort()).toEqual(['config', 'cost', 'notes', 'relations'])
    expect(await readdir(join(store.root, 'costs'))).toEqual([`${DEVICE}.jsonl`])
    expect(existsSync(join(store.root, 'relations.yaml'))).toBe(true)
  })

  it('lets the sync in once the writes already running are done', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    await store.writePaper(samplePaper(), null)
    const write = store.writeNotes(ID, 'in flight', null)
    let sawNotes = false
    await store.exclusive(async () => {
      sawNotes = existsSync(join(store.paperDir(ID), 'notes.md'))
    })
    await write
    expect(sawNotes).toBe(true)
  })

  it('lists only methods the store has', () => {
    for (const name of ProjectStore.GATED_WRITES) expect(typeof ProjectStore.prototype[name]).toBe('function')
  })
})
