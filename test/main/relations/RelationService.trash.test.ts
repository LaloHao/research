import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TrashRow } from '../../../src/main/cache/IndexCache'
import { relationId } from '../../../src/shared/typedRelations'
import { samplePaper } from '../../helpers/papers'
import { DRAIN_ID, LOGHUB_ID } from '../../helpers/pair'
import { setupRelations, typedRelation } from '../../helpers/relations'

const XU = 'xu2009logs'
const AM = 'am2019survey'
const xuRow: TrashRow = { id: XU, title: 'Console logs', authors_label: 'Xu', year: 2009, doi: null, openalex_id: null, trashed_at: null, device: null, problem: null }
const hidden = typedRelation({ from: XU, to: LOGHUB_ID, type: 'same_problem' })
const visible = typedRelation()

/**
 * Drain and Loghub in the library, Xu in the trash with one (hidden) relation to Loghub. A third library paper (Am) was
 * analyzed with Xu as a candidate, so a rekey or a removeTouching on Xu also has that paper's analyzed candidates to fix.
 */
async function withHidden() {
  const ctx = await setupRelations()
  const xu = samplePaper({ id: XU, title: 'Console logs', identifiers: {}, bibtex: '@article{xu2009logs,\n  title = {Console logs}\n}' })
  await ctx.store.writePaper(xu, null)
  ctx.cache.upsertPaper(xu, 'h', false)
  const am = samplePaper({ id: AM, title: 'A survey of log parsers', identifiers: {}, bibtex: '@article{am2019survey,\n  title = {A survey of log parsers}\n}' })
  await ctx.store.writePaper(am, null)
  ctx.cache.upsertPaper(am, 'h', false)
  await ctx.store.writeRelations(
    {
      schema_version: 1,
      relations: [visible, hidden],
      analyzed: {
        [XU]: { candidates: [LOGHUB_ID], at: '2026-10-10T00:00:00.000Z' },
        [AM]: { candidates: [XU, LOGHUB_ID], at: '2026-10-10T00:00:00.000Z' }
      }
    },
    null
  )
  ctx.cache.moveToTrash(xuRow)
  await ctx.service.reindex()
  return ctx
}

describe('RelationService and the trash', () => {
  it('hides relations with a trashed paper and keeps them out of an analysis, without dropping them from relations.yaml', async () => {
    const { service, provider, store } = await withHidden()
    expect(service.forPaper(LOGHUB_ID).suggested.map((r) => r.id)).toEqual([visible.id])
    await service.run(LOGHUB_ID, { force: true })
    expect(provider.agentCalls[0].input).not.toContain(XU)
    const read = await store.readRelations()
    expect(read?.ok && read.value.relations.map((r) => r.id)).toContain(hidden.id)
  })

  it('counts and removes the relations and the analysis of papers deleted for good', async () => {
    const { service, store } = await withHidden()
    expect(await service.countTouching([XU])).toBe(1)
    expect(await service.removeTouching([XU])).toBe(1)
    const read = await store.readRelations()
    expect(read?.ok && read.value.relations.map((r) => r.id)).toEqual([visible.id])
    expect(read?.ok && read.value.analyzed[XU]).toBeUndefined()
    expect(await service.removeTouching(['nothere'])).toBe(0)
  })

  it('counts a mix of a visible and a hidden relation, and both at once when both their ends are deleted', async () => {
    const { service } = await withHidden()
    expect(await service.countTouching([LOGHUB_ID])).toBe(2)
    expect(await service.countTouching([XU, LOGHUB_ID])).toBe(2)
  })

  it('removes the deleted keys from other papers analyzed candidates too', async () => {
    const { service, store } = await withHidden()
    await service.removeTouching([XU])
    const read = await store.readRelations()
    expect(read?.ok && read.value.analyzed[AM]?.candidates).toEqual([LOGHUB_ID])
  })

  it('writes nothing while relations.yaml has a git conflict', async () => {
    const { service, store } = await withHidden()
    const conflicted = '<<<<<<< HEAD\nschema_version: 1\n=======\nschema_version: 1\n>>>>>>> other\n'
    await writeFile(join(store.root, 'relations.yaml'), conflicted)
    await expect(service.removeTouching([XU])).rejects.toThrow('relations_conflict')
    await expect(service.rekey(XU, DRAIN_ID)).rejects.toThrow('relations_conflict')
    expect(await readFile(join(store.root, 'relations.yaml'), 'utf8')).toBe(conflicted)
  })

  it('moves the relations of a paper merged on restore onto the library paper', async () => {
    const { service, store } = await withHidden()
    await service.rekey(XU, DRAIN_ID)
    const read = await store.readRelations()
    expect(read?.ok && read.value.relations.map((r) => r.id).sort()).toEqual([visible.id, relationId(DRAIN_ID, LOGHUB_ID, 'same_problem')].sort())
    expect(read?.ok && read.value.analyzed[XU]).toBeUndefined()
  })

  it('renames the old key inside other papers analyzed candidates on rekey, deduped', async () => {
    const { service, store } = await withHidden()
    await service.rekey(XU, DRAIN_ID)
    const read = await store.readRelations()
    // Am's candidates named Xu and Loghub; Xu is renamed to Drain, with no duplicate.
    expect(read?.ok && read.value.analyzed[AM]?.candidates.sort()).toEqual([DRAIN_ID, LOGHUB_ID].sort())
  })
})
