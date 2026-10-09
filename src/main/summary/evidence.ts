import type { Evidence, ExtractionFile, SummaryFile } from '../../shared/summary'
import { findInNormalized, normalizeForMatch } from '../../shared/textMatch'
import type { PageText } from './paperText'

export function locateQuote(quote: string, pages: PageText[], hintPage: number | null): { page: number | null; found: boolean } {
  const q = normalizeForMatch(quote)
  const ordered = [...pages.filter((p) => p.page === hintPage), ...pages.filter((p) => p.page !== hintPage)]
  for (const p of ordered) {
    if (findInNormalized(q, normalizeForMatch(p.text))) return { page: p.page, found: true }
  }
  return { page: hintPage, found: false }
}

/** Fills `found` (and fixes `page`) on the evidence of generated fields, facets and thesis relation. */
export function checkEvidence(
  summary: SummaryFile,
  extraction: ExtractionFile,
  pages: PageText[]
): { summary: SummaryFile; extraction: ExtractionFile; found: number; total: number } {
  let found = 0
  let total = 0
  const check = (list: Evidence[]): Evidence[] =>
    list.map((e) => {
      total++
      const r = locateQuote(e.quote, pages, e.page)
      if (r.found) found++
      return { quote: e.quote, page: r.page, found: r.found }
    })
  const fields = Object.fromEntries(
    Object.entries(summary.fields).map(([k, f]) => [k, f.status === 'generated' ? { ...f, evidence: check(f.evidence) } : f])
  ) as SummaryFile['fields']
  const facets = Object.fromEntries(
    Object.entries(extraction.facets).map(([k, f]) => [k, f.status === 'generated' ? { ...f, evidence: check(f.evidence) } : f])
  )
  const relation = extraction.thesis_relation
  const thesis = relation?.status === 'generated' ? { thesis_relation: { ...relation, evidence: check(relation.evidence) } } : {}
  return { summary: { ...summary, fields }, extraction: { ...extraction, facets, ...thesis }, found, total }
}
