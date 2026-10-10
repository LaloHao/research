import type { BarDatum, BubbleDatum, ChartData, ChartQuery, FacetFilter, YearDatum } from '../../shared/relations'
import type { ExtractionFile, FacetDef } from '../../shared/summary'
import { entryFitsFacet } from '../summary/merge'

/** One value of one single/multi facet of a paper, as stored in the index (paper_facets). */
export interface FacetValueRow {
  facet: string
  value: string
  /** The entry is verified or edited. */
  reviewed: boolean
}

export interface FacetRow extends FacetValueRow {
  paperId: string
  year: number | null
}

type Counted = { reviewed: number; unreviewed: number }

const total = (d: Counted): number => d.reviewed + d.unreviewed

function bump(d: Counted, reviewed: boolean): void {
  if (reviewed) d.reviewed++
  else d.unreviewed++
}

/** The rows of one paper: entries that no longer fit their facet's type do not count (see entryFitsFacet). */
export function facetRowsFor(extraction: ExtractionFile | null, defs: FacetDef[] | null): FacetValueRow[] {
  if (!extraction || !defs) return []
  const rows: FacetValueRow[] = []
  for (const def of defs) {
    if (def.type !== 'single' && def.type !== 'multi') continue
    const entry = extraction.facets[def.key]
    if (!entry || !entryFitsFacet(def, entry)) continue
    const values = def.type === 'single' ? (entry.value ? [entry.value] : []) : (entry.values ?? [])
    const reviewed = entry.status === 'verified' || entry.status === 'edited'
    for (const value of new Set(values)) rows.push({ facet: def.key, value, reviewed })
  }
  return rows
}

function of(rows: FacetRow[], facet: string, onlyReviewed: boolean): FacetRow[] {
  return rows.filter((r) => r.facet === facet && (!onlyReviewed || r.reviewed))
}

export function barCounts(rows: FacetRow[], facet: string, onlyReviewed: boolean): BarDatum[] {
  const byValue = new Map<string, BarDatum>()
  for (const r of of(rows, facet, onlyReviewed)) {
    const d = byValue.get(r.value) ?? { value: r.value, reviewed: 0, unreviewed: 0 }
    bump(d, r.reviewed)
    byValue.set(r.value, d)
  }
  return [...byValue.values()].sort((a, b) => total(b) - total(a) || a.value.localeCompare(b.value))
}

function byPaper(rows: FacetRow[]): Map<string, FacetRow[]> {
  const map = new Map<string, FacetRow[]>()
  for (const r of rows) map.set(r.paperId, [...(map.get(r.paperId) ?? []), r])
  return map
}

export function bubbleCounts(rows: FacetRow[], facetX: string, facetY: string, onlyReviewed: boolean): Extract<ChartData, { kind: 'bubbles' }> {
  const xs = byPaper(of(rows, facetX, onlyReviewed))
  const ys = byPaper(of(rows, facetY, onlyReviewed))
  const cells = new Map<string, BubbleDatum>()
  for (const [paperId, xRows] of xs) {
    const yRows = ys.get(paperId)
    if (!yRows) continue
    for (const x of xRows) {
      for (const y of yRows) {
        const key = `${x.value}\u0000${y.value}`
        const cell = cells.get(key) ?? { x: x.value, y: y.value, reviewed: 0, unreviewed: 0 }
        bump(cell, x.reviewed && y.reviewed)
        cells.set(key, cell)
      }
    }
  }
  return {
    kind: 'bubbles',
    facet: facetX,
    facetY,
    xValues: barCounts(rows, facetX, onlyReviewed).map((b) => b.value),
    yValues: barCounts(rows, facetY, onlyReviewed).map((b) => b.value),
    cells: [...cells.values()].sort((a, b) => a.x.localeCompare(b.x) || a.y.localeCompare(b.y))
  }
}

export function yearCounts(rows: FacetRow[], facet: string, onlyReviewed: boolean): YearDatum[] {
  const byKey = new Map<string, YearDatum>()
  for (const r of of(rows, facet, onlyReviewed)) {
    if (r.year === null) continue
    const key = `${r.year}\u0000${r.value}`
    const d = byKey.get(key) ?? { year: r.year, value: r.value, reviewed: 0, unreviewed: 0 }
    bump(d, r.reviewed)
    byKey.set(key, d)
  }
  return [...byKey.values()].sort((a, b) => a.year - b.year || a.value.localeCompare(b.value))
}

export function chartData(rows: FacetRow[], query: ChartQuery): ChartData {
  switch (query.kind) {
    case 'bars':
      return { kind: 'bars', facet: query.facet, bars: barCounts(rows, query.facet, query.onlyReviewed) }
    case 'bubbles':
      return bubbleCounts(rows, query.facet, query.facetY, query.onlyReviewed)
    case 'years':
      return { kind: 'years', facet: query.facet, years: yearCounts(rows, query.facet, query.onlyReviewed) }
  }
}

/** Papers having every facet = value pair, reviewed or not. */
export function papersMatching(rows: FacetRow[], filters: FacetFilter[]): string[] {
  if (filters.length === 0) return []
  const matches = filters.map((f) => new Set(rows.filter((r) => r.facet === f.facet && r.value === f.value).map((r) => r.paperId)))
  return [...matches[0]].filter((id) => matches.every((set) => set.has(id))).sort()
}
