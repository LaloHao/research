import { ToolError, type LibraryTools, type PaperListItem } from './libraryTools'

/** At most this many passages from a search across the scope (the library's own search returns up to 20). */
const MAX_SCOPED_HITS = 20
/** Passages taken from each paper of the scope when the library-wide search found too few of them. */
const HITS_PER_PAPER = 3
/** The library tools list at most 50 papers per call. */
const LIST_PAGE = 50

/**
 * The read-only library tools limited to a set of papers (a draft's chosen ones): a tool about one paper refuses any
 * other, searches and lists return only papers of the set, and a paper's citations and neighbours only name papers
 * of the set. The facet overview (counts over the whole library, no paper text) stays as it is.
 */
export function scopeLibraryTools(tools: LibraryTools, papers: readonly string[]): LibraryTools {
  const scope = new Set(papers)
  const inScope = (id: string): boolean => scope.has(id)
  const require = (id: string): void => {
    if (!inScope(id)) throw new ToolError(`The paper "${id.slice(0, 40)}" is not among the papers chosen for this draft. Use only the keys given in <paper> tags.`)
  }

  return {
    async searchText(query, paperId, limit) {
      if (paperId !== undefined) {
        require(paperId)
        return tools.searchText(query, paperId, limit)
      }
      const max = Math.min(Math.max(1, Math.trunc(limit ?? 8)), MAX_SCOPED_HITS)
      const hits = (await tools.searchText(query, undefined, MAX_SCOPED_HITS)).filter((h) => inScope(h.paper_id))
      // Too few from the library-wide ranking: each chosen paper is searched on its own.
      for (const id of scope) {
        if (hits.length >= max) break
        if (hits.some((h) => h.paper_id === id)) continue
        hits.push(...(await tools.searchText(query, id, HITS_PER_PAPER).catch(() => [])))
      }
      return hits.slice(0, max)
    },
    async searchSimilar(query, limit) {
      const hits = await tools.searchSimilar(query, MAX_SCOPED_HITS)
      return hits.filter((h) => inScope(h.paper_id)).slice(0, Math.min(Math.max(1, Math.trunc(limit ?? 5)), MAX_SCOPED_HITS))
    },
    async findInPaper(paperId, text, limit) {
      require(paperId)
      return tools.findInPaper(paperId, text, limit)
    },
    async readPages(paperId, from, to) {
      require(paperId)
      return tools.readPages(paperId, from, to)
    },
    async getPaper(paperId) {
      require(paperId)
      return tools.getPaper(paperId)
    },
    async getCitations(paperId) {
      require(paperId)
      const c = await tools.getCitations(paperId)
      return { ...c, cites: c.cites.filter((p) => inScope(p.paper_id)), cited_by: c.cited_by.filter((p) => inScope(p.paper_id)) }
    },
    async getNeighbours(paperId) {
      require(paperId)
      const n = await tools.getNeighbours(paperId)
      return { ...n, similar: n.similar.filter((p) => inScope(p.paper_id)) }
    },
    async listPapers(offset, limit) {
      const all: PaperListItem[] = []
      for (let start = 0; ; start += LIST_PAGE) {
        const page = await tools.listPapers(start, LIST_PAGE)
        all.push(...page.papers.filter((p) => inScope(p.paper_id)))
        if (page.papers.length < LIST_PAGE || start + LIST_PAGE >= page.total) break
      }
      const from = typeof offset === 'number' && Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0
      return { total: all.length, offset: from, papers: all.slice(from, from + Math.min(Math.max(1, Math.trunc(limit ?? LIST_PAGE)), LIST_PAGE)) }
    },
    async getSummary(paperId) {
      require(paperId)
      return tools.getSummary(paperId)
    },
    facetOverview: () => tools.facetOverview()
  }
}
