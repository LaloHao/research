import { describe, expect, it, vi } from 'vitest'
import { MAPPING_SCHEMAS } from '../../../src/main/project/mappingFiles'
import * as yamlFile from '../../../src/main/project/yamlFile'
import { hexId, record, search, setupMappings } from '../../helpers/mappings'

// Counts every YAML parse while keeping the real one.
vi.mock('../../../src/main/project/yamlFile', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/main/project/yamlFile')>()
  return { ...original, parseYamlFile: vi.fn(original.parseYamlFile) }
})

const parses = vi.mocked(yamlFile.parseYamlFile)
const recordParses = (): number => parses.mock.calls.filter(([, schema]) => schema === MAPPING_SCHEMAS.records).length

describe('MappingService parses a mapping file only when its text changed', () => {
  it('a decision on a large mapping, the watcher and the reload never parse records.yaml again', async () => {
    const { service, store } = await setupMappings()
    const id = await service.create('Logs')
    const abstract = 'Software logs record what a system did, and sharing them leaks secrets. '.repeat(14)
    const records = Array.from({ length: 2000 }, (_, i) =>
      record({ id: hexId('r', i + 1), title: `Log study number ${i + 1} on anonymization`, identifiers: { doi: `10.5555/log.${i + 1}` }, abstract })
    )
    await store.writeMappingFile(id, 'searches', { schema_version: 1, searches: [search({ count: records.length })] }, null)
    await store.writeMappingFile(id, 'records', { schema_version: 1, records }, null)
    expect(await service.reindexIfChanged(id)).toBe(true)
    await service.open(id)

    parses.mockClear()
    await service.decide(id, { recordId: hexId('r', 7), phase: 'title_abstract', decision: 'include', criterion: null, suggestionId: null })
    // What the window and the watcher do after the write.
    expect(await service.reindexIfChanged(id)).toBe(false)
    await service.open(id)
    await service.open(id)
    expect(recordParses()).toBe(0)
    // Only the written file is parsed again, once.
    expect(parses.mock.calls.filter(([, schema]) => schema === MAPPING_SCHEMAS.decisions)).toHaveLength(1)
  })

  it('a file changed on disk is parsed again', async () => {
    const { service, store } = await setupMappings()
    const id = await service.create('Logs')
    await store.writeMappingFile(id, 'searches', { schema_version: 1, searches: [search({ count: 2 })] }, null)
    const hash = await store.writeMappingFile(id, 'records', { schema_version: 1, records: [record()] }, null)
    expect(await service.reindexIfChanged(id)).toBe(true)
    parses.mockClear()
    await store.writeMappingFile(id, 'records', { schema_version: 1, records: [record(), record({ id: hexId('r', 2), title: 'Another log study', identifiers: {} })] }, hash)
    expect(await service.reindexIfChanged(id)).toBe(true)
    expect(recordParses()).toBe(1)
    expect(service.queue(id, { phase: 'title_abstract', filter: 'pending' })).toHaveLength(2)
  })
})
