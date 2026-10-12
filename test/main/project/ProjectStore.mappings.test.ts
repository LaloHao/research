import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConflictError } from '../../../src/main/project/errors'
import { newMappingId, sortedMappingFile } from '../../../src/main/project/mappingFiles'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { decision, hexId, MAPPING_A, MAPPING_B, protocolBody, protocolFile, record } from '../../helpers/mappings'
import { tmpDir } from '../../helpers/tmp'

const open = async (): Promise<ProjectStore> => ProjectStore.create(await tmpDir(), 'Thesis')

describe('ProjectStore mappings', () => {
  it('creates a mapping with its protocol and lists the folders that have one', async () => {
    const store = await open()
    expect(await store.listMappingIds()).toEqual([])
    await store.writeMappingFile(MAPPING_B, 'protocol', protocolFile(), null)
    await store.writeMappingFile(MAPPING_A, 'protocol', protocolFile(), null)
    await writeFile(join(store.root, 'mappings', 'notes.txt'), 'x')
    expect(await store.listMappingIds()).toEqual([MAPPING_A, MAPPING_B])
    expect(store.mappingExists(MAPPING_A)).toBe(true)
    expect(await store.readMappingFile(MAPPING_A, 'protocol')).toMatchObject({ ok: true, value: { version: 1 } })
    expect(await store.readMappingFile(MAPPING_A, 'records')).toBeNull()
  })

  it('writes lists sorted, so two machines add lines in the same order', async () => {
    const store = await open()
    await store.writeMappingFile(MAPPING_A, 'protocol', protocolFile(), null)
    const later = record({ id: hexId('r', 2), added_at: '2026-10-12T12:00:00.000Z' })
    await store.writeMappingFile(MAPPING_A, 'records', { schema_version: 1, records: [later, record()] }, null)
    const read = await store.readMappingFile(MAPPING_A, 'records')
    expect(read?.ok && read.value.records.map((r) => r.id)).toEqual([hexId('r', 1), hexId('r', 2)])
  })

  it('checks the hash, refuses files with conflict markers and never writes into a mapping without its protocol', async () => {
    const store = await open()
    await expect(store.writeMappingFile(MAPPING_A, 'decisions', { schema_version: 1, decisions: [decision()] }, null)).rejects.toBeInstanceOf(ConflictError)
    const hash = await store.writeMappingFile(MAPPING_A, 'protocol', protocolFile(), null)
    await expect(store.writeMappingFile(MAPPING_A, 'protocol', protocolFile({ version: 2 }), null)).rejects.toBeInstanceOf(ConflictError)
    const path = join(store.mappingDir(MAPPING_A), 'protocol.yaml')
    const text = await readFile(path, 'utf8')
    const conflicted = `<<<<<<< ours\n${text}=======\n${text}>>>>>>> theirs\n`
    await writeFile(path, conflicted)
    const read = await store.readMappingFile(MAPPING_A, 'protocol')
    expect(read).toMatchObject({ ok: false, problem: { kind: 'conflict_markers' } })
    await expect(store.writeMappingFile(MAPPING_A, 'protocol', protocolFile({ version: 2 }), hash)).rejects.toBeInstanceOf(ConflictError)
    // Even with the hash of the conflicted text itself, the file is left to the user.
    await expect(store.writeMappingFile(MAPPING_A, 'protocol', protocolFile({ version: 2 }), read!.hash)).rejects.toBeInstanceOf(ConflictError)
    expect(await readFile(path, 'utf8')).toBe(conflicted)
  })

  it('validates what it writes and refuses ids that could leave the folder', async () => {
    const store = await open()
    await expect(store.writeMappingFile(MAPPING_A, 'protocol', protocolFile({ version: 0 }), null)).rejects.toThrow()
    expect(() => store.mappingDir('../x')).toThrow('Invalid mapping id')
    expect(store.mappingExists('../x')).toBe(false)
    await expect(store.readMappingFile('../x', 'protocol')).rejects.toThrow('Invalid mapping id')
    await expect(store.writeMappingFile(`${MAPPING_A}/../..`, 'protocol', protocolFile(), null)).rejects.toThrow('Invalid mapping id')
  })

  it('keeps keys it does not know, so a newer machine loses nothing', async () => {
    const store = await open()
    await store.writeMappingFile(MAPPING_A, 'protocol', protocolFile({ classification: { facets: [] } } as never), null)
    const hash = (await store.readMappingFile(MAPPING_A, 'decisions'))?.hash ?? null
    await store.writeMappingFile(MAPPING_A, 'decisions', { schema_version: 1, decisions: [decision({ weight: 2 } as never)] }, hash)
    const protocol = await store.readMappingFile(MAPPING_A, 'protocol')
    const decisions = await store.readMappingFile(MAPPING_A, 'decisions')
    expect(protocol).toMatchObject({ ok: true, value: { classification: { facets: [] } } })
    expect(decisions).toMatchObject({ ok: true, value: { decisions: [{ weight: 2 }] } })
  })

  it('sorts the protocol history by version', () => {
    const v1 = { version: 1, replaced_at: '2026-10-12T10:00:00.000Z', protocol: protocolBody() }
    const v2 = { version: 2, replaced_at: '2026-10-12T11:00:00.000Z', protocol: protocolBody() }
    const sorted = sortedMappingFile('protocol', protocolFile({ version: 3, history: [v2, v1] }))
    expect(sorted.history.map((h) => h.version)).toEqual([1, 2])
  })

  it('names new mappings by date and a random part', () => {
    expect(newMappingId(new Date('2026-10-12T09:00:00.000Z'), 'a1b2ffff')).toBe(MAPPING_A)
  })
})
