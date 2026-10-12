import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IndexCache, type MappingIndexEntry } from '../../../src/main/cache/IndexCache'
import {
  EMPTY_PHASE_VIEW,
  PHASE_STATES,
  type MappingRecordRow,
  type PhaseState,
  type PrismaColumn,
  type PrismaCounts,
  type ScreeningCounts
} from '../../../src/shared/mapping'
import { AT, hexId, MAPPING_A, MAPPING_B } from '../../helpers/mappings'
import { tmpDir } from '../../helpers/tmp'

const row = (n: number, state: PhaseState, over: Partial<MappingRecordRow> = {}): MappingRecordRow => ({
  id: hexId('r', n),
  title: `Record ${n}`,
  authors_label: 'He',
  authors: 'Pinjia He',
  year: 2017,
  venue: null,
  abstract: null,
  kind: 'conference',
  doi: null,
  arxiv: null,
  openalex: null,
  paper_id: null,
  sources: [hexId('s', 1)],
  active: true,
  column: 'databases',
  duplicate: null,
  title_abstract: { ...EMPTY_PHASE_VIEW, state, decisionId: state === 'pending' ? null : hexId('d', n) },
  full_text: EMPTY_PHASE_VIEW,
  suggestions: { title_abstract: null, full_text: null },
  added_at: AT,
  ...over
})

const zeros = (): Record<PhaseState, number> => Object.fromEntries(PHASE_STATES.map((s) => [s, 0])) as Record<PhaseState, number>

const column = (over: Partial<PrismaColumn> = {}): PrismaColumn => ({
  identified: [{ kind: 'import', database: 'Scopus', count: 2 }],
  duplicates: 0,
  screened: 2,
  excludedScreening: 0,
  pendingScreening: 1,
  sought: 1,
  notRetrieved: 0,
  assessed: 0,
  excludedFullText: [],
  pendingFullText: 1,
  included: 0,
  ...over
})

const entry = (id: string, over: Partial<MappingIndexEntry> = {}): MappingIndexEntry => {
  const rows = [row(1, 'include'), row(2, 'pending', { title: 'Second' }), row(3, 'pending', { active: false })]
  const counts: ScreeningCounts = { title_abstract: { ...zeros(), pending: 1, include: 1 }, full_text: { ...zeros(), pending: 1 } }
  const prisma: PrismaCounts = { databases: column(), other: column({ identified: [], screened: 0, pendingScreening: 0, sought: 0, pendingFullText: 0 }), included: 0 }
  return { id, title: 'Log anonymization', updatedAt: '2026-10-12T10:00:00.000Z', hashes: { 'protocol.yaml': 'h1', 'records.yaml': 'h2' }, rows, prisma, counts, ...over }
}

describe('IndexCache mappings', () => {
  it('keeps each mapping’s rows, counts, PRISMA and file hashes, replaced as a whole', async () => {
    const cache = IndexCache.open(join(await tmpDir(), 'index.sqlite'))
    expect(cache.mappingFileHashes(MAPPING_A)).toBeNull()
    cache.replaceMapping(entry(MAPPING_A))
    cache.replaceMapping(entry(MAPPING_B, { title: 'Other', updatedAt: '2026-10-12T11:00:00.000Z' }))
    expect(cache.mappingIds()).toEqual([MAPPING_A, MAPPING_B])
    expect(cache.mappingFileHashes(MAPPING_A)).toEqual({ 'protocol.yaml': 'h1', 'records.yaml': 'h2' })
    expect(cache.mappingSummaries()).toEqual([
      { id: MAPPING_B, title: 'Other', records: 2, pending: 1, included: 0, problem: null, updatedAt: '2026-10-12T11:00:00.000Z' },
      { id: MAPPING_A, title: 'Log anonymization', records: 2, pending: 1, included: 0, problem: null, updatedAt: '2026-10-12T10:00:00.000Z' }
    ])
    expect(cache.mappingRows(MAPPING_A).map((r) => r.id)).toEqual([hexId('r', 1), hexId('r', 2), hexId('r', 3)])
    expect(cache.mappingRows(MAPPING_A)).toEqual(entry(MAPPING_A).rows)
    expect(cache.mappingRow(MAPPING_A, hexId('r', 1))?.title_abstract.state).toBe('include')
    expect(cache.mappingRow(MAPPING_A, hexId('r', 9))).toBeNull()
    expect(cache.mappingState(MAPPING_A)).toEqual({ prisma: entry(MAPPING_A).prisma, counts: entry(MAPPING_A).counts })
    cache.replaceMapping(entry(MAPPING_A, { rows: [], hashes: { 'protocol.yaml': 'h3' } }))
    expect(cache.mappingRows(MAPPING_A)).toEqual([])
    expect(cache.mappingFileHashes(MAPPING_A)).toEqual({ 'protocol.yaml': 'h3' })
    expect(cache.mappingRows(MAPPING_B)).toHaveLength(3)
    cache.close()
  })

  it('lists mappings without a date last', async () => {
    const cache = IndexCache.open(join(await tmpDir(), 'index.sqlite'))
    cache.setMappingProblem(MAPPING_B, { title: 'Broken', hashes: {}, problem: 'mapping_invalid' })
    cache.replaceMapping(entry(MAPPING_A))
    expect(cache.mappingSummaries().map((s) => s.id)).toEqual([MAPPING_A, MAPPING_B])
    cache.close()
  })

  it('records a mapping whose files do not read, without rows, and forgets removed mappings', async () => {
    const cache = IndexCache.open(join(await tmpDir(), 'index.sqlite'))
    cache.replaceMapping(entry(MAPPING_A))
    cache.setMappingProblem(MAPPING_A, { title: null, hashes: { 'protocol.yaml': 'h9' }, problem: 'mapping_invalid' })
    expect(cache.mappingSummaries()).toEqual([{ id: MAPPING_A, title: '', records: 0, pending: 0, included: 0, problem: 'mapping_invalid', updatedAt: null }])
    expect(cache.mappingRows(MAPPING_A)).toEqual([])
    expect(cache.mappingState(MAPPING_A)).toBeNull()
    expect(cache.mappingFileHashes(MAPPING_A)).toEqual({ 'protocol.yaml': 'h9' })
    cache.removeMapping(MAPPING_A)
    expect(cache.mappingIds()).toEqual([])
    expect(cache.mappingFileHashes(MAPPING_A)).toBeNull()
    cache.close()
  })

  it('migrates a schema 9 cache in place, keeping its rows', async () => {
    const file = join(await tmpDir(), 'index.sqlite')
    const db = new DatabaseSync(file)
    db.exec(
      "CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT NOT NULL, unfilled_facets INTEGER NOT NULL DEFAULT 0); INSERT INTO papers (id, title) VALUES ('he2017drain', 'Drain'); CREATE TABLE paper_vectors (paper_id TEXT PRIMARY KEY, vector BLOB NOT NULL); INSERT INTO paper_vectors VALUES ('he2017drain', x'0102'); PRAGMA user_version = 9"
    )
    db.close()
    const cache = IndexCache.open(file)
    cache.replaceMapping(entry(MAPPING_A))
    expect(cache.mappingRows(MAPPING_A)).toHaveLength(3)
    cache.close()
    const check = new DatabaseSync(file)
    expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 10 })
    expect(check.prepare('SELECT id FROM papers').all().map((r) => ({ ...r }))).toEqual([{ id: 'he2017drain' }])
    expect(check.prepare('SELECT COUNT(*) AS n FROM paper_vectors').get()).toMatchObject({ n: 1 })
    check.close()
  })

  it('migrates a schema 8 cache straight to 10, with the mapping tables', async () => {
    const file = join(await tmpDir(), 'index.sqlite')
    const db = new DatabaseSync(file)
    db.exec("CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT NOT NULL); INSERT INTO papers (id, title) VALUES ('he2017drain', 'Drain'); PRAGMA user_version = 8")
    db.close()
    const cache = IndexCache.open(file)
    cache.replaceMapping(entry(MAPPING_A))
    expect(cache.mappingIds()).toEqual([MAPPING_A])
    cache.close()
    const check = new DatabaseSync(file)
    expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 10 })
    expect(check.prepare('SELECT id, unfilled_facets FROM papers').all().map((r) => ({ ...r }))).toEqual([{ id: 'he2017drain', unfilled_facets: 0 }])
    check.close()
  })
})
