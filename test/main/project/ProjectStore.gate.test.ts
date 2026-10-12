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

  /**
   * Every method on the prototype must be gated or explicitly known to not write (a read, a path/name helper, or
   * `reloadConfig`/`removeCachedPdf`/`exclusive`/`constructor`). A new writer added without being listed in either
   * place fails this test, instead of silently bypassing the gate the way `writeBib` once did.
   */
  const UNGATED = [
    'constructor',
    'exclusive',
    'reloadConfig',
    'paperDir',
    'paperExists',
    'listPaperIds',
    'readPaper',
    'readNotes',
    'pdfLocation',
    'resolvePdf',
    'removeCachedPdf',
    'readContent',
    'readSummary',
    'readExtraction',
    'readRelations',
    'readFacetSuggestions',
    'trashDir',
    'trashExists',
    'listTrash',
    'readTrashedPaper',
    'listTrashedFiles',
    'readTrashedFile',
    'readPaperFile',
    'freeSibling',
    'readCosts',
    // Private helpers called only from inside an already-gated method; wrapping them again would deadlock.
    'requirePaper',
    'move',
    'readTrashedInfo',
    'moveOutOfTrash',
    'removeTrashDirIfDone',
    'writeChecked',
    'syncIgnoreFiles'
  ]

  it('accounts for every prototype method as gated or explicitly non-writing', () => {
    for (const name of Object.getOwnPropertyNames(ProjectStore.prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(ProjectStore.prototype, name)!
      if (typeof descriptor.value !== 'function') continue // getters (config, cacheDir, exportsDir) only compute a value
      expect([...ProjectStore.GATED_WRITES, ...UNGATED]).toContain(name)
    }
  })

  it('holds the bibliography write while the sync has the folder', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const sync = store.exclusive(() => held)
    let wrote = false
    const write = store.writeBib([{ id: ID, bibtex: '@misc{he2017drain,\n  title = {Drain}\n}' }]).then((changed) => {
      wrote = changed
    })
    await tick()
    expect(wrote).toBe(false)
    expect(existsSync(join(store.exportsDir, 'library.bib'))).toBe(false)
    release()
    await sync
    await write
    expect(wrote).toBe(true)
    expect(existsSync(join(store.exportsDir, 'library.bib'))).toBe(true)
  })
})
