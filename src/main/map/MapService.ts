import type { ChartData, ChartQuery, FacetFilter, FacetOption, GraphData, LinkedPaper, RelationsDetail } from '../../shared/relations'
import type { IndexCache, RelationRow } from '../cache/IndexCache'
import type { ProjectStore } from '../project/ProjectStore'
import { loadForm } from '../summary/extractionForm'
import { chartData, papersMatching } from './facetStats'

const linked = (r: RelationRow): LinkedPaper => ({ id: r.id, title: r.title, year: r.year })

function uniqueByTitle(papers: LinkedPaper[]): LinkedPaper[] {
  return [...new Map(papers.map((p) => [p.id, p])).values()].sort((a, b) => a.title.localeCompare(b.title))
}

/** Read-only queries over the index for the Relations tab and the Map view. */
export class MapService {
  constructor(private readonly deps: { store: ProjectStore; cache: IndexCache }) {}

  async relations(paperId: string): Promise<RelationsDetail> {
    const { store, cache } = this.deps
    const read = store.paperExists(paperId) ? await store.readPaper(paperId) : null
    const rows = cache.relationRows()
    const byId = new Map(rows.map((r) => [r.id, r]))
    const byOpenAlex = new Map(rows.flatMap((r) => (r.openalex_id ? [[r.openalex_id, r] as const] : [])))
    const self = byId.get(paperId)
    const edges = cache.citationEdges()
    const own = edges.filter((e) => e.citing === paperId)
    const cites = own.flatMap((e) => {
      const r = byOpenAlex.get(e.cited)
      return r && r.id !== paperId ? [linked(r)] : []
    })
    const citedBy = self?.openalex_id
      ? edges
          .filter((e) => e.cited === self.openalex_id && e.citing !== paperId)
          .flatMap((e) => {
            const r = byId.get(e.citing)
            return r ? [linked(r)] : []
          })
      : []
    const similar = cache.similarFor(paperId).flatMap((s) => {
      const r = byId.get(s.other)
      return r ? [{ ...linked(r), score: s.score, reasons: s.reasons }] : []
    })
    return {
      citations: read?.ok ? (read.value.citations ?? null) : null,
      cites: uniqueByTitle(cites),
      citedBy: uniqueByTitle(citedBy),
      similar,
      externalReferences: own.filter((e) => !byOpenAlex.has(e.cited)).length
    }
  }

  graph(): GraphData {
    const { cache } = this.deps
    const rows = cache.relationRows()
    const ids = new Set(rows.map((r) => r.id))
    const byOpenAlex = new Map(rows.flatMap((r) => (r.openalex_id ? [[r.openalex_id, r.id] as const] : [])))
    const facets = new Map<string, Record<string, string[]>>()
    for (const r of cache.facetRows()) {
      const byFacet = facets.get(r.paperId) ?? {}
      ;(byFacet[r.facet] ??= []).push(r.value)
      facets.set(r.paperId, byFacet)
    }
    const citations: GraphData['citations'] = []
    const seen = new Set<string>()
    for (const e of cache.citationEdges()) {
      const target = byOpenAlex.get(e.cited)
      const key = `${e.citing}>${target}`
      if (!target || target === e.citing || !ids.has(e.citing) || seen.has(key)) continue
      seen.add(key)
      citations.push({ source: e.citing, target })
    }
    const pairs = new Map<string, GraphData['similarities'][number]>()
    for (const s of cache.allSimilar()) {
      if (!ids.has(s.a) || !ids.has(s.b)) continue
      const key = [s.a, s.b].sort().join('|')
      const current = pairs.get(key)
      if (!current || s.score > current.score) pairs.set(key, { source: s.a, target: s.b, score: s.score, reasons: s.reasons })
    }
    return {
      nodes: rows.map((r) => ({
        id: r.id,
        title: r.title,
        year: r.year,
        citedByCount: r.cited_by_count,
        facets: facets.get(r.id) ?? {},
        thesisScore: r.thesis_score
      })),
      citations,
      similarities: [...pairs.values()]
    }
  }

  facetOptions(): FacetOption[] {
    const form = loadForm(this.deps.store.config.extraction_form)
    if (form.status !== 'ok') return []
    return form.form.facets.flatMap((f) => (f.type === 'single' || f.type === 'multi' ? [{ key: f.key, values: f.values }] : []))
  }

  chart(query: ChartQuery): ChartData {
    return chartData(this.deps.cache.facetRows(), query)
  }

  facetPaperIds(filters: FacetFilter[]): string[] {
    return papersMatching(this.deps.cache.facetRows(), filters)
  }
}
