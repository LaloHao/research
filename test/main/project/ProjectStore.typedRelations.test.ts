import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConflictError } from '../../../src/main/project/errors'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { toYaml } from '../../../src/main/project/yamlFile'
import { relationId, type RelationType, type TypedRelation } from '../../../src/shared/typedRelations'
import { tmpDir } from '../../helpers/tmp'

function rel(from: string, to: string, type: RelationType, over: Partial<TypedRelation> = {}): TypedRelation {
  return { id: relationId(from, to, type), type, from, to, status: 'suggested', edited: false, justification: 'j', evidence: [], updated_at: '2026-10-10T10:00:00.000Z', ...over }
}

describe('ProjectStore relations.yaml', () => {
  it('reads nothing when the file is missing, writes entries sorted by id and checks the hash', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    expect(await store.readRelations()).toBeNull()
    const z = rel('zhu2020loghub', 'he2017drain', 'extends')
    const a = rel('am2019x', 'he2017drain', 'same_problem')
    const hash = await store.writeRelations({ schema_version: 1, relations: [z, a], analyzed: {} }, null)
    const read = await store.readRelations()
    expect(read?.ok && read.value.relations.map((r) => r.id)).toEqual([a.id, z.id])
    expect(read?.hash).toBe(hash)
    await expect(store.writeRelations({ schema_version: 1, relations: [], analyzed: {} }, null)).rejects.toBeInstanceOf(ConflictError)
  })

  it('reports conflict markers and resolves them into the union of both sides', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    const ours = rel('zhu2020loghub', 'he2017drain', 'extends', { status: 'confirmed', updated_at: '2026-10-10T12:00:00.000Z' })
    const other = rel('am2019x', 'he2017drain', 'same_problem')
    const text = `<<<<<<< HEAD\n${toYaml({ schema_version: 1, relations: [ours] })}=======\n${toYaml({ schema_version: 1, relations: [other] })}>>>>>>> origin/main\n`
    await writeFile(join(store.root, 'relations.yaml'), text)
    const read = await store.readRelations()
    expect(read?.ok === false && read.problem.kind).toBe('conflict_markers')
    expect(await store.resolveRelationsConflict()).toEqual({ dropped: 0 })
    const resolved = await store.readRelations()
    expect(resolved?.ok && resolved.value.relations.map((r) => r.id)).toEqual([other.id, ours.id])
    expect(await readFile(join(store.root, 'relations.yaml'), 'utf8')).not.toContain('<<<<<<<')
  })

  it('leaves a file it cannot resolve untouched', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    const text = '<<<<<<< HEAD\nrelations: [\n=======\nnot yaml: [\n>>>>>>> b\n'
    await writeFile(join(store.root, 'relations.yaml'), text)
    expect(await store.resolveRelationsConflict()).toBeNull()
    expect(await readFile(join(store.root, 'relations.yaml'), 'utf8')).toBe(text)
  })
})
