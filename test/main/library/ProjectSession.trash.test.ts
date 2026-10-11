import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectSession } from '../../../src/main/library/ProjectSession'
import { libraryTools, ToolError } from '../../../src/main/mcp/libraryTools'
import { routeFetch } from '../../helpers/fakeFetch'
import { DRAIN_ID, LOGHUB_ID, seedPair } from '../../helpers/pair'
import { typedRelation } from '../../helpers/relations'
import { tmpDir } from '../../helpers/tmp'

const base = { contactEmail: '', citationPauseMs: 0, fetch: routeFetch([]), deviceId: '33333333-3333-3333-3333-333333333333' }
const REL = typedRelation()

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Drain and Loghub with real PDFs, indexed, and one suggested relation between them. */
async function seeded(opts: { watch?: boolean } = {}) {
  const s = await ProjectSession.create(await tmpDir(), 'Thesis', { ...base, watch: opts.watch ?? false })
  await seedPair(s.store, s.cache, { index: (id) => s.library.indexPaper(id) })
  await s.store.writeRelations({ schema_version: 1, relations: [REL], analyzed: {} }, null)
  await s.relations.reindex()
  await s.library.exportBib()
  return s
}

describe('ProjectSession trash', () => {
  it('hides a trashed paper from every read path and brings it all back on restore', async () => {
    const s = await seeded()
    const tools = libraryTools({ store: s.store, cache: s.cache, map: s.map, embeddings: null })
    const bib = join(s.store.exportsDir, 'library.bib')
    expect(await s.trash([DRAIN_ID])).toEqual({ moved: [DRAIN_ID], error: null })

    expect(s.library.list().map((r) => r.id)).toEqual([LOGHUB_ID])
    expect(s.library.list('fixed depth')).toEqual([])
    const graph = s.map.graph()
    expect(graph.nodes.map((n) => n.id)).toEqual([LOGHUB_ID])
    expect(graph.citations).toEqual([])
    expect(graph.typed).toEqual([])
    expect(s.relations.forPaper(LOGHUB_ID).suggested).toEqual([])
    expect(s.library.list()[0].relations_pending).toBe(0)
    expect(await s.reviewQueue()).toEqual([])
    expect(await tools.searchText('fixed depth parse tree')).toEqual([])
    await expect(tools.getPaper(DRAIN_ID)).rejects.toBeInstanceOf(ToolError)
    expect((await tools.getCitations(LOGHUB_ID)).cites).toEqual([])
    expect(await readFile(bib, 'utf8')).not.toContain(DRAIN_ID)
    const { candidates } = await s.citations.candidates({ direction: 'references', minCount: 1 })
    expect(candidates.map((c) => [c.openalexId, c.trashedId])).toEqual([['W2754665629', DRAIN_ID]])
    const kept = await s.store.readRelations()
    expect(kept?.ok && kept.value.relations).toEqual([REL])

    expect(await s.restore([DRAIN_ID], { merge: false })).toEqual({ restored: [{ id: DRAIN_ID, key: DRAIN_ID }], conflicts: [], failed: [] })
    expect(s.library.list().map((r) => r.id).sort()).toEqual([DRAIN_ID, LOGHUB_ID])
    expect(s.map.graph().typed.map((e) => e.id)).toEqual([REL.id])
    expect(await readFile(bib, 'utf8')).toContain(DRAIN_ID)
    await s.close()
  })

  it('cancels the queued jobs of a paper it trashes', async () => {
    const s = await seeded()
    await s.queue.stop()
    s.queue.enqueue({ type: 'citations', paperId: DRAIN_ID })
    s.queue.enqueue({ type: 'citations', paperId: LOGHUB_ID })
    await s.trash([DRAIN_ID])
    expect(s.queue.list().map((j) => [('paperId' in j.spec ? j.spec.paperId : null), j.state])).toEqual([
      [LOGHUB_ID, 'queued'],
      [DRAIN_ID, 'cancelled']
    ])
    await s.close()
  })

  it('deletes a paper for good together with its relations', async () => {
    const s = await seeded()
    await s.trash([DRAIN_ID])
    const plan = await s.deletePlan('all')
    expect(plan).toEqual({ ids: [DRAIN_ID], papers: 1, relations: 1 })
    expect(await s.deleteForever(plan.ids)).toBe(1)
    const read = await s.store.readRelations()
    expect(read?.ok && read.value.relations).toEqual([])
    expect(existsSync(join(s.store.root, '.trash', DRAIN_ID))).toBe(false)
    expect(await s.listTrash()).toEqual([])
    await s.close()
  })

  it('follows folders that a git pull moves in and out of .trash/', async () => {
    const s = await seeded({ watch: true })
    const trashed = join(s.store.root, '.trash', DRAIN_ID)
    await mkdir(join(s.store.root, '.trash'), { recursive: true })
    await rename(s.store.paperDir(DRAIN_ID), trashed)
    await waitFor(() => s.cache.trashEntries().some((e) => e.id === DRAIN_ID) && !s.library.list().some((r) => r.id === DRAIN_ID))
    expect(s.map.graph().typed).toEqual([])
    await rename(trashed, s.store.paperDir(DRAIN_ID))
    await waitFor(() => s.cache.trashEntries().length === 0 && s.library.list().some((r) => r.id === DRAIN_ID))
    await s.close()
  })
})
