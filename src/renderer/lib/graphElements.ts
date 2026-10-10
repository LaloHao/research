import type { GraphData, GraphNode } from '../../shared/relations'

export type Lens = { kind: 'area'; facet: string | null } | { kind: 'thesis' }

/** Categorical palette (Tableau 10); the last color is for "other values". */
export const PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'] as const
export const NONE_COLOR = '#d0d0d0'
/** Light to dark blue: relevance 1 to 5. */
export const THESIS_COLORS = ['#c6dbef', '#9ecae1', '#6baed6', '#3182bd', '#08519c'] as const
/** Legend labels the view translates. */
export const OTHER_VALUES = '__other__'
export const NO_VALUE = '__none__'

export interface LegendItem {
  label: string
  color: string
  count: number
}

export function valueFrequencies(nodes: GraphNode[], facet: string): Map<string, number> {
  const freq = new Map<string, number>()
  for (const n of nodes) for (const v of n.facets[facet] ?? []) freq.set(v, (freq.get(v) ?? 0) + 1)
  return freq
}

/** A paper with several values takes the one most frequent in the library (ties: alphabetical). */
export function dominantValue(values: string[], freq: ReadonlyMap<string, number>): string | null {
  return [...values].sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0) || a.localeCompare(b))[0] ?? null
}

export function lensColors(nodes: GraphNode[], lens: Lens): { color: Map<string, string>; legend: LegendItem[] } {
  const color = new Map<string, string>()
  const counts = new Map<string, number>()
  const colorOf = new Map<string, string>()
  const assign = (id: string, label: string, c: string): void => {
    color.set(id, c)
    counts.set(label, (counts.get(label) ?? 0) + 1)
    colorOf.set(label, c)
  }
  const legendFor = (order: string[]): LegendItem[] =>
    order.filter((label) => counts.has(label)).map((label) => ({ label, color: colorOf.get(label)!, count: counts.get(label)! }))

  if (lens.kind === 'thesis') {
    for (const n of nodes) {
      const score = n.thesisScore
      if (score !== null && score >= 1 && score <= 5) assign(n.id, String(score), THESIS_COLORS[score - 1])
      else assign(n.id, NO_VALUE, NONE_COLOR)
    }
    return { color, legend: legendFor(['5', '4', '3', '2', '1', NO_VALUE]) }
  }
  if (!lens.facet) {
    for (const n of nodes) color.set(n.id, NONE_COLOR)
    return { color, legend: [] }
  }
  const facet = lens.facet
  const freq = valueFrequencies(nodes, facet)
  const ranked = [...freq.keys()].sort((a, b) => freq.get(b)! - freq.get(a)! || a.localeCompare(b))
  const palette = new Map(ranked.slice(0, PALETTE.length - 1).map((v, i) => [v, PALETTE[i] as string]))
  for (const n of nodes) {
    const value = dominantValue(n.facets[facet] ?? [], freq)
    if (value === null) assign(n.id, NO_VALUE, NONE_COLOR)
    else if (palette.has(value)) assign(n.id, value, palette.get(value)!)
    else assign(n.id, OTHER_VALUES, PALETTE[PALETTE.length - 1])
  }
  return { color, legend: legendFor([...palette.keys(), OTHER_VALUES, NO_VALUE]) }
}

/** Node diameter by total citations in OpenAlex, on a log scale. */
export function nodeSize(citedByCount: number | null): number {
  return Math.min(48, 14 + 6 * Math.log10(1 + Math.max(0, citedByCount ?? 0)))
}

export function shortLabel(title: string, year: number | null): string {
  const short = title.length > 40 ? `${title.slice(0, 39).trimEnd()}…` : title
  return year ? `${short} (${year})` : short
}

export interface GraphOptions {
  lens: Lens
  showCitations: boolean
  showSimilarity: boolean
  /** Similarity edges below this score are hidden. */
  threshold: number
  /** Only these papers (the library's current filters), or all. */
  visibleIds: ReadonlySet<string> | null
}

export interface ElementDef {
  group: 'nodes' | 'edges'
  data: Record<string, unknown>
  classes?: string
}

/** Cytoscape elements; colors come from the whole library so they stay put when filtering. */
export function buildElements(data: GraphData, opts: GraphOptions): ElementDef[] {
  const { color } = lensColors(data.nodes, opts.lens)
  const nodes = opts.visibleIds ? data.nodes.filter((n) => opts.visibleIds!.has(n.id)) : data.nodes
  const ids = new Set(nodes.map((n) => n.id))
  const out: ElementDef[] = nodes.map((n) => ({
    group: 'nodes',
    data: { id: n.id, label: shortLabel(n.title, n.year), color: color.get(n.id) ?? NONE_COLOR, size: nodeSize(n.citedByCount) }
  }))
  if (opts.showCitations) {
    for (const e of data.citations) {
      if (ids.has(e.source) && ids.has(e.target)) out.push({ group: 'edges', data: { id: `c:${e.source}>${e.target}`, source: e.source, target: e.target }, classes: 'citation' })
    }
  }
  if (opts.showSimilarity) {
    for (const e of data.similarities) {
      if (e.score < opts.threshold || !ids.has(e.source) || !ids.has(e.target)) continue
      out.push({ group: 'edges', data: { id: `s:${e.source}|${e.target}`, source: e.source, target: e.target, score: e.score, reasons: e.reasons }, classes: 'similarity' })
    }
  }
  return out
}

export interface LayoutPlan {
  relayout: boolean
  randomize: boolean
}

/**
 * Whether the layout runs again after an update, given the papers of the last layout (`null`: none yet).
 * An empty graph never spends the randomized first layout; the layout starts from the current positions
 * unless no paper keeps one.
 */
export function layoutPlan(previous: ReadonlySet<string> | null, next: readonly string[]): LayoutPlan {
  if (next.length === 0) return { relayout: false, randomize: false }
  if (previous === null) return { relayout: true, randomize: true }
  const same = next.length === previous.size && next.every((id) => previous.has(id))
  if (same) return { relayout: false, randomize: false }
  return { relayout: true, randomize: !next.some((id) => previous.has(id)) }
}

export interface Point {
  x: number
  y: number
}

/** Where a node added to a laid-out graph starts: by a neighbour (slightly apart), else somewhere inside the graph. */
export function initialPosition(
  neighbour: Point | null,
  box: { x1: number; y1: number; x2: number; y2: number } | null,
  random: () => number = Math.random
): Point | undefined {
  if (neighbour) return { x: neighbour.x + (random() - 0.5) * 40, y: neighbour.y + (random() - 0.5) * 40 }
  if (box) return { x: box.x1 + random() * (box.x2 - box.x1), y: box.y1 + random() * (box.y2 - box.y1) }
  return undefined
}
