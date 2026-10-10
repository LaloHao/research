import type { Candidate, CandidateQuery, ExternalWork } from '../../shared/relations'

export interface CandidateInput {
  /** citing = library paper id, cited = OpenAlex id. */
  references: { citing: string; cited: string }[]
  /** paperId = cited library paper, citing = OpenAlex id. */
  incoming: { paperId: string; citing: string }[]
  library: { id: string; openalexId: string | null; doi: string | null }[]
  dismissed: ReadonlySet<string>
  works: ReadonlyMap<string, ExternalWork>
}

const strength = (c: Candidate): number => Math.max(c.citedByLibrary, c.citesLibrary)

/** Works outside the library linked to it by citations, either way (snowballing). */
export function computeCandidates(input: CandidateInput, query: CandidateQuery): Candidate[] {
  const inLibrary = new Set(input.library.flatMap((p) => (p.openalexId ? [p.openalexId] : [])))
  const libraryDois = new Set(input.library.flatMap((p) => (p.doi ? [p.doi.toLowerCase()] : [])))
  const related = new Map<string, { citedBy: Set<string>; cites: Set<string> }>()
  const entry = (id: string): { citedBy: Set<string>; cites: Set<string> } => {
    let e = related.get(id)
    if (!e) related.set(id, (e = { citedBy: new Set(), cites: new Set() }))
    return e
  }
  for (const e of input.references) if (!inLibrary.has(e.cited)) entry(e.cited).citedBy.add(e.citing)
  for (const e of input.incoming) if (!inLibrary.has(e.citing)) entry(e.citing).cites.add(e.paperId)

  const out: Candidate[] = []
  for (const [openalexId, rel] of related) {
    if (input.dismissed.has(openalexId)) continue
    const work = input.works.get(openalexId) ?? null
    if (work?.doi && libraryDois.has(work.doi.toLowerCase())) continue
    const candidate: Candidate = {
      openalexId,
      work,
      citedByLibrary: rel.citedBy.size,
      citesLibrary: rel.cites.size,
      paperIds: [...new Set([...rel.citedBy, ...rel.cites])].sort()
    }
    const count =
      query.direction === 'references' ? candidate.citedByLibrary : query.direction === 'citing' ? candidate.citesLibrary : strength(candidate)
    if (count < query.minCount) continue
    if (query.paperId && !candidate.paperIds.includes(query.paperId)) continue
    out.push(candidate)
  }
  return out.sort(
    (a, b) => strength(b) - strength(a) || (b.work?.citedByCount ?? 0) - (a.work?.citedByCount ?? 0) || a.openalexId.localeCompare(b.openalexId)
  )
}
