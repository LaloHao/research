import type { ChartData, FacetFilter } from '../../shared/relations'
import { PALETTE } from './graphElements'

/** One mark of a chart: a bar segment (reviewed or not) or a bubble. */
export interface PlotRow {
  x: string | number
  y: string | null
  value: string | null
  count: number
  reviewed: boolean
}

export function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: (string | number)[][]): string {
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\n')}\n`
}

/** Column names are data identifiers (facet keys), not UI text. */
export function chartCsv(data: ChartData): string {
  switch (data.kind) {
    case 'bars':
      return toCsv([[data.facet, 'reviewed', 'unreviewed', 'total'], ...data.bars.map((b) => [b.value, b.reviewed, b.unreviewed, b.reviewed + b.unreviewed])])
    case 'bubbles':
      return toCsv([
        [data.facet, data.facetY, 'reviewed', 'unreviewed', 'total'],
        ...data.cells.map((c) => [c.x, c.y, c.reviewed, c.unreviewed, c.reviewed + c.unreviewed])
      ])
    case 'years':
      return toCsv([['year', data.facet, 'reviewed', 'unreviewed', 'total'], ...data.years.map((d) => [d.year, d.value, d.reviewed, d.unreviewed, d.reviewed + d.unreviewed])])
  }
}

export function chartFileName(data: ChartData, ext: 'svg' | 'png' | 'csv'): string {
  return `${data.kind}-${data.facet}${data.kind === 'bubbles' ? `-${data.facetY}` : ''}.${ext}`
}

function split(x: string | number, value: string, reviewed: number, unreviewed: number): PlotRow[] {
  const rows: PlotRow[] = []
  if (reviewed > 0) rows.push({ x, y: null, value, count: reviewed, reviewed: true })
  if (unreviewed > 0) rows.push({ x, y: null, value, count: unreviewed, reviewed: false })
  return rows
}

export function chartRows(data: ChartData): PlotRow[] {
  switch (data.kind) {
    case 'bars':
      return data.bars.flatMap((b) => split(b.value, b.value, b.reviewed, b.unreviewed))
    case 'years':
      return data.years.flatMap((d) => split(d.year, d.value, d.reviewed, d.unreviewed))
    case 'bubbles':
      // A bubble is drawn dim unless every paper in it is reviewed.
      return data.cells.map((c) => ({ x: c.x, y: c.y, value: null, count: c.reviewed + c.unreviewed, reviewed: c.unreviewed === 0 }))
  }
}

/** The library filter a click on `row` opens. */
export function pickFilters(data: ChartData, row: PlotRow): FacetFilter[] {
  switch (data.kind) {
    case 'bars':
      return [{ facet: data.facet, value: String(row.x) }]
    case 'years':
      return row.value ? [{ facet: data.facet, value: row.value }] : []
    case 'bubbles':
      return [
        { facet: data.facet, value: String(row.x) },
        { facet: data.facetY, value: row.y ?? '' }
      ]
  }
}

export function tipLabel(data: ChartData, row: PlotRow): string {
  switch (data.kind) {
    case 'bars':
      return String(row.x)
    case 'years':
      return `${row.x} · ${row.value}`
    case 'bubbles':
      return `${row.x} × ${row.y}`
  }
}

/** Values of the per-year chart, most frequent first, cycling through the palette. */
export function yearColors(data: Extract<ChartData, { kind: 'years' }>): Map<string, string> {
  const totals = new Map<string, number>()
  for (const d of data.years) totals.set(d.value, (totals.get(d.value) ?? 0) + d.reviewed + d.unreviewed)
  const ranked = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)! || a.localeCompare(b))
  return new Map(ranked.map((v, i) => [v, PALETTE[i % PALETTE.length] as string]))
}
