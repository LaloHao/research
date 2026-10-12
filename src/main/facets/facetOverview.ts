import type { ExtractionFile, ExtractionForm, FacetDef, FacetEntry } from '../../shared/summary'
import type { IndexCache } from '../cache/IndexCache'
import type { ProjectStore } from '../project/ProjectStore'
import { entryFitsFacet } from '../summary/merge'

export interface FacetValueCount {
  value: string
  papers: number
}

/** A value papers proposed that is neither allowed nor aliased yet, with the papers (keys) that proposed it. */
export interface ProposedValue {
  value: string
  papers: string[]
}

export interface FacetUsage {
  key: string
  type: FacetDef['type']
  description: string
  allowed: string[]
  /** Papers whose classification has an entry for this facet. */
  filled: number
  /** Chosen values (single/multi) or scores (scale), by how many papers have them. */
  values: FacetValueCount[]
  proposed: ProposedValue[]
}

export interface FacetOverview {
  /** Papers with a classification. */
  papers: number
  facets: FacetUsage[]
}

export interface PaperExtraction {
  paperId: string
  extraction: ExtractionFile
}

/** What a facet entry holds, by type: the value, the values, the text, or the score with its justification. */
export function facetEntryValue(def: FacetDef, entry: FacetEntry): unknown {
  switch (def.type) {
    case 'single':
      return entry.value ?? null
    case 'multi':
      return entry.values ?? []
    case 'text':
      return entry.text ?? ''
    case 'scale':
      return { score: entry.score ?? null, justification: entry.justification ?? '' }
  }
}

function countedValues(def: FacetDef, entry: FacetEntry): string[] {
  switch (def.type) {
    case 'single':
      return entry.value ? [entry.value] : []
    case 'multi':
      return [...new Set(entry.values ?? [])]
    case 'scale':
      return entry.score === undefined ? [] : [String(entry.score)]
    case 'text':
      return []
  }
}

const byPapers = (a: { value: string; n: number }, b: { value: string; n: number }): number => b.n - a.n || a.value.localeCompare(b.value)

/** How each facet of `form` is used across the classifications; an entry that no longer fits its facet's type is skipped. */
export function computeFacetOverview(form: ExtractionForm, extractions: PaperExtraction[]): FacetOverview {
  const facets = form.facets.map((def): FacetUsage => {
    const allowed = 'values' in def ? def.values : []
    const aliases = form.value_aliases[def.key] ?? {}
    const counts = new Map<string, number>()
    const proposed = new Map<string, string[]>()
    let filled = 0
    for (const { paperId, extraction } of extractions) {
      const entry = extraction.facets[def.key]
      if (!entry || !entryFitsFacet(def, entry)) continue
      filled++
      for (const v of countedValues(def, entry)) counts.set(v, (counts.get(v) ?? 0) + 1)
      for (const p of new Set(entry.proposed)) {
        if (allowed.includes(p) || aliases[p] !== undefined) continue
        proposed.set(p, [...(proposed.get(p) ?? []), paperId])
      }
    }
    return {
      key: def.key,
      type: def.type,
      description: def.description,
      allowed,
      filled,
      values: [...counts]
        .map(([value, n]) => ({ value, n }))
        .sort(byPapers)
        .map(({ value, n }) => ({ value, papers: n })),
      proposed: [...proposed]
        .map(([value, papers]) => ({ value, n: papers.length, papers: [...papers].sort() }))
        .sort(byPapers)
        .map(({ value, papers }) => ({ value, papers }))
    }
  })
  return { papers: extractions.length, facets }
}

/** Every readable library paper's classification; papers with a file problem, or without a classification, are left out. */
export async function libraryExtractions(store: ProjectStore, cache: IndexCache): Promise<PaperExtraction[]> {
  const out: PaperExtraction[] = []
  for (const paperId of await store.listPaperIds()) {
    const row = cache.getPaper(paperId)
    if (!row || row.problem) continue
    const read = await store.readExtraction(paperId).catch(() => null)
    if (read?.ok) out.push({ paperId, extraction: read.value })
  }
  return out
}
