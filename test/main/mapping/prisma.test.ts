import { describe, expect, it } from 'vitest'
import { prismaCounts } from '../../../src/main/mapping/prisma'
import { recordRows } from '../../../src/main/mapping/screening'
import type { Decision, Phase } from '../../../src/shared/mapping'
import { AT, decision, hexId, protocolFile, record, search } from '../../helpers/mappings'

const S = { scopus: hexId('s', 1), ieee: hexId('s', 2), openalex: hexId('s', 3), snowball: hexId('s', 4), library: hexId('s', 5) }
let n = 0
const decide = (rec: number, phase: Phase, value: Decision['decision'], criterion: string | null = null): Decision =>
  decision({ id: hexId('d', ++n), record: hexId('r', rec), phase, decision: value, criterion })

describe('prismaCounts', () => {
  it('counts both PRISMA 2020 columns from the live searches and the current decisions', () => {
    const searches = [
      search({ id: S.scopus, database: 'Scopus', count: 3 }),
      search({ id: S.ieee, database: 'IEEE Xplore', count: 2 }),
      search({ id: S.openalex, kind: 'openalex', database: 'OpenAlex', count: 2, discarded: { at: AT, reason: 'Too broad.', machine: 'machine-a' } }),
      search({ id: S.snowball, kind: 'snowball', database: 'OpenAlex', count: 2 }),
      search({ id: S.library, kind: 'library', database: 'library', count: 1 })
    ]
    const records = [
      record({ id: hexId('r', 1), sources: [S.scopus, S.ieee, S.snowball] }),
      record({ id: hexId('r', 2), sources: [S.scopus], identifiers: {} }),
      record({ id: hexId('r', 3), sources: [S.scopus], identifiers: {} }),
      record({ id: hexId('r', 4), sources: [S.ieee], identifiers: {} }),
      record({ id: hexId('r', 5), sources: [S.snowball], identifiers: {} }),
      record({ id: hexId('r', 7), sources: [S.openalex], identifiers: {} }),
      record({ id: hexId('r', 8), sources: [S.library], identifiers: {} })
    ]
    const decisions = [
      decide(1, 'title_abstract', 'include'),
      decide(1, 'full_text', 'include'),
      decide(2, 'title_abstract', 'exclude', 'E1'),
      decide(3, 'title_abstract', 'include'),
      decide(3, 'full_text', 'exclude', 'E2'),
      decide(4, 'title_abstract', 'include'),
      decide(4, 'full_text', 'not_retrieved'),
      decide(5, 'title_abstract', 'include'),
      decide(7, 'title_abstract', 'include')
    ]
    const rows = recordRows({ protocol: protocolFile(), searches, records, decisions, suggestions: [] })
    expect(prismaCounts(rows, searches)).toEqual({
      databases: {
        identified: [
          { kind: 'import', database: 'Scopus', count: 3 },
          { kind: 'import', database: 'IEEE Xplore', count: 2 }
        ],
        duplicates: 1,
        screened: 4,
        excludedScreening: 1,
        pendingScreening: 0,
        sought: 3,
        notRetrieved: 1,
        assessed: 2,
        excludedFullText: [{ criterion: 'E2', count: 1 }],
        pendingFullText: 0,
        included: 1
      },
      other: {
        identified: [
          { kind: 'snowball', database: 'snowball', count: 2 },
          { kind: 'library', database: 'library', count: 1 }
        ],
        duplicates: 1,
        screened: 2,
        excludedScreening: 0,
        pendingScreening: 1,
        sought: 1,
        notRetrieved: 0,
        assessed: 0,
        excludedFullText: [],
        pendingFullText: 1,
        included: 0
      },
      included: 1
    })
  })

  it('orders the full-text reasons by criterion number', () => {
    const searches = [search({ count: 3 })]
    const records = [1, 2, 3].map((i) => record({ id: hexId('r', i), identifiers: {} }))
    const decisions = [1, 2, 3].flatMap((i) => [decide(i, 'title_abstract', 'include'), decide(i, 'full_text', 'exclude', ['E10', 'E2', 'E2'][i - 1])])
    const rows = recordRows({ protocol: protocolFile(), searches, records, decisions, suggestions: [] })
    expect(prismaCounts(rows, searches).databases.excludedFullText).toEqual([
      { criterion: 'E2', count: 2 },
      { criterion: 'E10', count: 1 }
    ])
  })
})

/** A small deterministic generator, so the invariants run over many shapes without flaky failures. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('prismaCounts invariants', () => {
  const KINDS = ['import', 'openalex', 'snowball', 'library'] as const
  const TA = ['include', 'exclude', 'uncertain', 'none'] as const
  const FT = ['include', 'exclude', 'uncertain', 'not_retrieved', 'none'] as const

  it('accounts for every record exactly once per box, across many random mappings', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed)
      const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]
      let dn = 0
      const searches = Array.from({ length: 1 + Math.floor(rand() * 5) }, (_, i) =>
        search({
          id: hexId('s', i + 1),
          kind: pick(KINDS),
          database: pick(['Scopus', 'IEEE Xplore', 'OpenAlex']),
          count: 0,
          discarded: rand() < 0.2 ? { at: AT, reason: 'Discarded.', machine: 'machine-a' } : null
        })
      )
      const records = Array.from({ length: Math.floor(rand() * 25) }, (_, i) => {
        const sources = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 2) }, () => pick(searches).id))]
        return record({ id: hexId('r', i + 1), identifiers: {}, sources, merged_into: i > 0 && rand() < 0.1 ? hexId('r', 1) : null })
      })
      // Each search read its records, plus some entries that collapsed into a record it already brought.
      for (const s of searches) s.count = records.filter((r) => r.sources.includes(s.id)).length + Math.floor(rand() * 3)
      const decisions: Decision[] = []
      const decideChain = (rec: string, phase: Phase, values: readonly Decision['decision'][]): void => {
        const steps = Math.floor(rand() * 3)
        let heads: string[] = []
        for (let k = 0; k < steps; k++) {
          const value = pick(values)
          const made = Array.from({ length: rand() < 0.15 ? 2 : 1 }, () => {
            const v = rand() < 0.5 ? value : pick(values)
            return decision({ id: hexId('d', ++dn), record: rec, phase, decision: v, criterion: v === 'exclude' ? pick(['E1', 'E2']) : null, replaces: heads, at: `2026-10-12T10:${String(dn % 60).padStart(2, '0')}:00.000Z` })
          })
          decisions.push(...made)
          heads = made.map((d) => d.id)
        }
      }
      for (const r of records) {
        decideChain(r.id, 'title_abstract', TA)
        decideChain(r.id, 'full_text', FT)
      }
      const rows = recordRows({ protocol: protocolFile(), searches, records, decisions, suggestions: [] })
      const p = prismaCounts(rows, searches)
      const live = searches.filter((s) => !s.discarded)
      for (const key of ['databases', 'other'] as const) {
        const c = p[key]
        const columnRows = rows.filter((r) => r.active && r.column === key)
        const identified = c.identified.reduce((sum, x) => sum + x.count, 0)
        expect(identified).toBe(live.filter((s) => (key === 'databases') === (s.kind === 'import' || s.kind === 'openalex')).reduce((sum, s) => sum + s.count, 0))
        expect(c.screened).toBe(columnRows.length)
        expect(c.duplicates + c.screened).toBe(identified)
        expect(c.excludedScreening + c.pendingScreening + c.sought).toBe(c.screened)
        expect(c.notRetrieved + c.assessed + c.pendingFullText).toBe(c.sought)
        expect(c.excludedFullText.reduce((sum, x) => sum + x.count, 0) + c.included).toBe(c.assessed)
      }
      expect(p.included).toBe(p.databases.included + p.other.included)
      expect(p.databases.screened + p.other.screened).toBe(rows.filter((r) => r.active).length)
    }
  })

  it('keeps a record in the databases column when another machine also found it by snowballing, and counts that read as a duplicate of «other methods»', () => {
    const searches = [search({ id: S.scopus, count: 1 }), search({ id: S.snowball, kind: 'snowball', database: 'OpenAlex', count: 1 })]
    const rows = recordRows({ protocol: protocolFile(), searches, records: [record({ sources: [S.snowball, S.scopus] })], decisions: [], suggestions: [] })
    const p = prismaCounts(rows, searches)
    expect([p.databases.screened, p.databases.duplicates, p.other.screened, p.other.duplicates]).toEqual([1, 0, 0, 1])
  })

  it('counts a record in conflict as still to decide in its phase', () => {
    const searches = [search({ count: 1 })]
    const first = decision({ id: hexId('d', 101) })
    const a = decision({ id: hexId('d', 102), replaces: [first.id], decision: 'exclude', criterion: 'E1', machine: 'machine-a' })
    const b = decision({ id: hexId('d', 103), replaces: [first.id], decision: 'uncertain', machine: 'machine-b' })
    const rows = recordRows({ protocol: protocolFile(), searches, records: [record()], decisions: [first, a, b], suggestions: [] })
    expect(prismaCounts(rows, searches).databases).toMatchObject({ screened: 1, pendingScreening: 1, excludedScreening: 0, sought: 0 })
  })
})
