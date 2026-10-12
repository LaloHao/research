import { describe, expect, it, vi } from 'vitest'
import { readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProtocolDraft } from '../../../src/shared/mapping'
import { candidate, decision, fixturePath, hexId, record, search, setupMappings } from '../../helpers/mappings'
import { samplePaper } from '../../helpers/papers'

vi.mock('../../../src/main/mapping/importers/importFile', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/main/mapping/importers/importFile')>()
  return {
    ...mod,
    // An export «longer than the limit»: the real parser sets `truncated` only past 50 000 entries.
    parseExport: (name: string, text: string) => {
      const parsed = mod.parseExport(name, text)
      return parsed && name === 'truncated.bib' ? { ...parsed, truncated: true as const } : parsed
    }
  }
})

const draft = (over: Partial<ProtocolDraft> = {}): ProtocolDraft => ({
  title: 'Log anonymization',
  objective: 'Map the approaches.',
  research_questions: [{ id: null, text: 'Which techniques?' }],
  inclusion: [{ id: null, text: 'Processes software logs.' }],
  exclusion: [{ id: null, text: 'Not peer reviewed.' }],
  years: { from: 2015, to: null },
  publication_types: ['article', 'conference'],
  ...over
})

describe('MappingService', () => {
  it('creates a mapping, lists it and opens it', async () => {
    const { service, changes } = await setupMappings()
    const id = await service.create('  Log anonymization  ')
    expect(id).toBe('20261012-100000-0001')
    expect(service.list()).toEqual([{ id, title: 'Log anonymization', records: 0, pending: 0, included: 0, problem: null, updatedAt: '2026-10-12T10:00:00.000Z' }])
    const view = await service.open(id)
    expect(view).toMatchObject({ id, searches: [], duplicates: [], conflicts: [], screeningStarted: false, inconsistentSearches: [], prisma: { included: 0 } })
    expect(view.protocol).toMatchObject({ version: 1, protocol: { title: 'Log anonymization', inclusion: [] } })
    expect(changes()).toBe(1)
    await expect(service.open('20261012-100000-ffff')).rejects.toMatchObject({ code: 'mapping_not_found' })
  })

  it('imports exports, deduplicating across them, and logs each search with its database and string', async () => {
    const { service } = await setupMappings()
    const id = await service.create('Logs')
    expect(await service.importFile(id, fixturePath('scopus.csv'), { database: 'Scopus', query: 'TITLE-ABS-KEY(log*)' })).toEqual({ read: 4, added: 4, merged: 0, linked: 0, doubtful: 0, skipped: 1 })
    expect(await service.importFile(id, fixturePath('ieee.csv'), { database: 'IEEE Xplore', query: '"log parsing"' })).toEqual({ read: 3, added: 1, merged: 2, linked: 0, doubtful: 0, skipped: 0 })
    expect(await service.importFile(id, fixturePath('generic.csv'), { database: 'Mi lista', query: '  ' })).toMatchObject({ read: 2, added: 1, merged: 1 })
    const view = await service.open(id)
    expect(view.searches.map((s) => [s.kind, s.database, s.format, s.count, s.query, s.file])).toEqual([
      ['import', 'Mi lista', 'csv', 2, null, 'generic.csv'],
      ['import', 'IEEE Xplore', 'csv_ieee', 3, '"log parsing"', 'ieee.csv'],
      ['import', 'Scopus', 'csv_scopus', 4, 'TITLE-ABS-KEY(log*)', 'scopus.csv']
    ])
    expect(view.searches[2]).toMatchObject({ skipped: 1, machine: 'machine-a', at: '2026-10-12T10:00:00.000Z', capped: false })
    expect(view.prisma.databases).toMatchObject({
      identified: [
        { kind: 'import', database: 'Scopus', count: 4 },
        { kind: 'import', database: 'IEEE Xplore', count: 3 },
        { kind: 'import', database: 'Mi lista', count: 2 }
      ],
      screened: 6,
      duplicates: 3,
      pendingScreening: 6
    })
    expect(service.list()[0]).toMatchObject({ records: 6, pending: 6 })
  })

  it('reads BibTeX and RIS exports, and says when an export was cut short', async () => {
    const { service, root } = await setupMappings()
    const id = await service.create('Logs')
    expect(await service.importFile(id, fixturePath('acm.bib'), { database: 'ACM Digital Library', query: 'q' })).toMatchObject({ added: expect.any(Number) })
    expect(await service.importFile(id, fixturePath('wos.ris'), { database: 'Web of Science', query: 'q' })).not.toHaveProperty('truncated')
    const path = join(root, 'truncated.bib')
    await writeFile(path, await readFile(fixturePath('acm.bib')))
    expect(await service.importFile(id, path, { database: 'ACM Digital Library', query: 'q' })).toMatchObject({ truncated: true })
    const view = await service.open(id)
    expect(view.searches.map((s) => [s.format, s.capped])).toEqual([
      ['bibtex', true],
      ['ris', false],
      ['bibtex', false]
    ])
  })

  it('refuses a file that is not an export it reads, a missing one and one too large', async () => {
    const { service, root, changes } = await setupMappings()
    const id = await service.create('Logs')
    const path = join(root, 'notes.txt')
    await writeFile(path, 'hello')
    await expect(service.importFile(id, path, { database: 'Scopus', query: '' })).rejects.toMatchObject({ code: 'import_unreadable' })
    await expect(service.importFile(id, join(root, 'missing.csv'), { database: 'Scopus', query: '' })).rejects.toMatchObject({ code: 'import_unreadable' })
    await expect(service.importFile(id, root, { database: 'Scopus', query: '' })).rejects.toMatchObject({ code: 'import_unreadable' })
    const big = join(root, 'big.csv')
    await writeFile(big, '')
    await truncate(big, 20 * 1024 * 1024 + 1)
    await expect(service.importFile(id, big, { database: 'Scopus', query: '' })).rejects.toMatchObject({ code: 'file_too_large' })
    await expect(service.importFile(id, fixturePath('scopus.csv'), { database: '  ', query: '' })).rejects.toMatchObject({ code: 'invalid_edit' })
    expect(changes()).toBe(1)
  })

  it('links records that are library papers, and adds library papers as records', async () => {
    const { service, store, library } = await setupMappings()
    await store.writePaper(samplePaper(), null)
    await library.indexPaper('he2017drain')
    const id = await service.create('Logs')
    expect(await service.importFile(id, fixturePath('scopus.csv'), { database: 'Scopus', query: 'q' })).toMatchObject({ added: 4, linked: 1 })
    expect(await service.addFromLibrary(id, ['he2017drain', 'missing2020x'])).toEqual({ read: 1, added: 0, merged: 1, linked: 0, doubtful: 0, skipped: 0 })
    const other = await service.create('Other')
    expect(await service.addFromLibrary(other, ['he2017drain'])).toMatchObject({ added: 1, linked: 1 })
    const view = await service.open(other)
    expect(view.searches[0]).toMatchObject({ kind: 'library', database: 'library', count: 1 })
    expect(view.prisma.other.identified).toEqual([{ kind: 'library', database: 'library', count: 1 }])
    await expect(service.addFromLibrary(other, ['missing2020x'])).rejects.toMatchObject({ code: 'file_problem' })
  })

  it('lists doubtful duplicates and resolves them as the same work or as distinct works', async () => {
    const { service } = await setupMappings()
    const id = await service.create('Logs')
    const journal = candidate({ identifiers: { doi: '10.5555/drain.journal' }, abstract: 'The journal version.' })
    const shortened = candidate({ identifiers: {}, title: 'Drain: An Online Log Parsing Approach with a Fixed Depth Tree' })
    expect(await service.addSearch(id, { kind: 'openalex', database: 'OpenAlex', query: 'drain' }, [candidate(), journal, shortened])).toMatchObject({ added: 3, doubtful: 2 })
    const pairs = (await service.open(id)).duplicates
    const byReason = new Map(pairs.map((p) => [p.reason, p]))
    expect([...byReason.keys()].sort()).toEqual(['conflicting_ids', 'similar_title'])
    const journalPair = byReason.get('conflicting_ids')!
    expect(journalPair.other.doi).toBe('10.1109/icws.2017.13')
    await service.resolveDuplicate(id, journalPair.record.id, true)
    await service.resolveDuplicate(id, byReason.get('similar_title')!.record.id, false)
    const view = await service.open(id)
    expect(view.duplicates).toEqual([])
    expect(view.prisma.databases).toMatchObject({ screened: 2, duplicates: 1 })
    await expect(service.resolveDuplicate(id, journalPair.record.id, true)).rejects.toMatchObject({ code: 'mapping_not_found' })
    // The same works found again stay settled.
    expect(await service.addSearch(id, { kind: 'openalex', database: 'OpenAlex', query: 'drain again' }, [candidate(), journal, shortened])).toMatchObject({ added: 0, merged: 3 })
    expect((await service.open(id)).duplicates).toEqual([])
  })

  it('shows records two machines added under different ids for one work, with their reason', async () => {
    const { service, store } = await setupMappings()
    const id = await service.create('Logs')
    await store.writeMappingFile(id, 'searches', { schema_version: 1, searches: [search({ id: hexId('s', 1), count: 1 }), search({ id: hexId('s', 2), count: 1, machine: 'machine-b' })] }, null)
    await store.writeMappingFile(
      id,
      'records',
      {
        schema_version: 1,
        records: [
          record({ id: hexId('r', 1), sources: [hexId('s', 1)] }),
          record({ id: hexId('r', 2), sources: [hexId('s', 2)], identifiers: { doi: '10.1109/icws.2017.13', openalex: 'W1' }, added_at: '2026-10-12T09:30:00.000Z' })
        ]
      },
      null
    )
    const view = await service.open(id)
    expect(view.duplicates).toEqual([expect.objectContaining({ reason: 'same_id', record: expect.objectContaining({ id: hexId('r', 2) }), other: expect.objectContaining({ id: hexId('r', 1) }) })])
    await service.resolveDuplicate(id, hexId('r', 2), true)
    const after = await service.open(id)
    expect(after.duplicates).toEqual([])
    expect(after.prisma.databases).toMatchObject({ screened: 1, duplicates: 1 })
    const records = await store.readMappingFile(id, 'records')
    expect(records?.ok && records.value.records.find((r) => r.id === hexId('r', 1))).toMatchObject({ sources: [hexId('s', 1), hexId('s', 2)], identifiers: { doi: '10.1109/icws.2017.13', openalex: 'W1' } })
  })

  it('flags a search whose count is lower than the records it brought', async () => {
    const { service, store } = await setupMappings()
    const id = await service.create('Logs')
    await store.writeMappingFile(id, 'searches', { schema_version: 1, searches: [search({ id: hexId('s', 1), count: 0 })] }, null)
    await store.writeMappingFile(id, 'records', { schema_version: 1, records: [record({ id: hexId('r', 1), sources: [hexId('s', 1)] })] }, null)
    expect((await service.open(id)).inconsistentSearches).toEqual([hexId('s', 1)])
    await service.addSearch(id, { kind: 'openalex', database: 'OpenAlex', query: 'q', count: 0 }, [candidate({ identifiers: {}, title: 'A completely different title about logs', year: 2020 })])
    const view = await service.open(id)
    expect(view.searches[0].count).toBe(1)
    expect(view.inconsistentSearches).toEqual([hexId('s', 1)])
  })

  it('discards a search with a reason: its records leave the screening and the diagram', async () => {
    const { service } = await setupMappings()
    const id = await service.create('Logs')
    await service.addSearch(id, { kind: 'openalex', database: 'OpenAlex', query: 'too broad' }, [candidate()])
    const searchId = (await service.open(id)).searches[0].id
    await expect(service.discardSearch(id, searchId, '  ')).rejects.toMatchObject({ code: 'invalid_edit' })
    await service.discardSearch(id, searchId, 'Cadena demasiado amplia.')
    const view = await service.open(id)
    expect(view.searches[0].discarded).toEqual({ at: '2026-10-12T10:00:00.000Z', reason: 'Cadena demasiado amplia.', machine: 'machine-a' })
    expect(view.prisma.databases).toMatchObject({ identified: [], screened: 0 })
    await expect(service.discardSearch(id, hexId('s', 99), 'x')).rejects.toMatchObject({ code: 'mapping_not_found' })
  })

  it('saves the protocol with ids for new items, and a new version once screening started', async () => {
    const { service, store } = await setupMappings()
    const id = await service.create('Logs')
    await service.saveProtocol(id, draft(), 1)
    let view = await service.open(id)
    expect(view.protocol).toMatchObject({ version: 1, protocol: { research_questions: [{ id: 'RQ1' }], inclusion: [{ id: 'I1' }], exclusion: [{ id: 'E1' }] } })
    await store.writeMappingFile(id, 'decisions', { schema_version: 1, decisions: [decision()] }, null)
    await service.saveProtocol(id, { ...draft(), exclusion: [{ id: 'E1', text: 'Not peer reviewed.' }, { id: null, text: 'Not in English.' }] }, 1)
    view = await service.open(id)
    expect(view).toMatchObject({ screeningStarted: true, protocol: { version: 2, history: [{ version: 1 }] } })
    expect(view.protocol.protocol.exclusion.map((c) => c.id)).toEqual(['E1', 'E2'])
    await expect(service.saveProtocol(id, draft(), 1)).rejects.toMatchObject({ code: 'conflict' })
    await expect(service.saveProtocol(id, { ...draft(), title: '' }, 2)).rejects.toMatchObject({ code: 'invalid_edit' })
  })

  it('reads again and retries once when a file changed between its read and its write', async () => {
    const { service, store } = await setupMappings()
    const id = await service.create('Logs')
    await service.addSearch(id, { kind: 'openalex', database: 'OpenAlex', query: 'first' }, [candidate()])
    const write = store.writeMappingFile.bind(store)
    let interfered = false
    store.writeMappingFile = (async (mapping, kind, file, hash) => {
      if (!interfered && kind === 'searches') {
        interfered = true
        // Another machine's search arrives (a sync) between the read and the write.
        const current = await store.readMappingFile(mapping, 'searches')
        if (current?.ok) await write(mapping, 'searches', { ...current.value, searches: [...current.value.searches, search({ id: hexId('s', 99), count: 0, machine: 'machine-b' })] }, current.hash)
      }
      return write(mapping, kind, file, hash)
    }) as typeof store.writeMappingFile
    const outcome = await service.addSearch(id, { kind: 'openalex', database: 'OpenAlex', query: 'second' }, [candidate({ identifiers: {}, title: 'Another work on parsing logs online', year: 2020 })])
    expect(outcome).toMatchObject({ read: 1, added: 1, merged: 0 })
    const view = await service.open(id)
    expect(view.searches.map((s) => s.query).sort()).toEqual(['TITLE-ABS-KEY(log AND anonymization)', 'first', 'second'])
    expect(view.prisma.databases.screened).toBe(2)
  })

  it('re-indexes only after a change made outside it, shows a mapping whose file does not read, and forgets a removed one', async () => {
    const { service, store } = await setupMappings()
    const id = await service.create('Logs')
    await service.addSearch(id, { kind: 'openalex', database: 'OpenAlex', query: 'q' }, [candidate()])
    expect(await service.reindexIfChanged(id)).toBe(false)
    const path = join(store.mappingDir(id), 'records.yaml')
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.replace('ICWS', 'ICWS 2017'))
    expect(await service.reindexIfChanged(id)).toBe(true)
    await writeFile(path, `<<<<<<< ours\n${text}=======\n${text}>>>>>>> theirs\n`)
    expect(await service.reindexIfChanged(id)).toBe(true)
    expect(service.list()[0]).toMatchObject({ id, problem: 'mapping_invalid', records: 0 })
    await expect(service.open(id)).rejects.toMatchObject({ code: 'mapping_invalid' })
    await expect(service.addSearch(id, { kind: 'openalex', database: 'OpenAlex', query: 'q' }, [candidate()])).rejects.toMatchObject({ code: 'mapping_invalid' })
    await rm(store.mappingDir(id), { recursive: true })
    expect(await service.reindexIfChanged(id)).toBe(true)
    expect(service.list()).toEqual([])
  })

  it('indexes every mapping on disk when the project opens, and forgets the ones gone', async () => {
    const { service, store, cache } = await setupMappings()
    const a = await service.create('A')
    const b = await service.create('B')
    cache.removeMapping(a)
    await rm(store.mappingDir(b), { recursive: true })
    await service.reindexAll()
    expect(service.list().map((m) => m.id)).toEqual([a])
  })
})
