import type { Candidate } from '../../shared/relations'

/** Rows shown at once; the filters narrow the rest down. */
export const MAX_ROWS = 200

/** One paper's candidates are few: any shared citation counts. */
export function defaultMinCount(paperId: string | null): number {
  return paperId ? 1 : 2
}

export function candidateTitle(c: Candidate): string {
  return c.work?.title ?? c.openalexId
}

export function candidateLink(c: Candidate): string {
  return c.work?.doi ? `https://doi.org/${c.work.doi}` : `https://openalex.org/${c.openalexId}`
}

/** A work that is a paper in the trash is restored, never added a second time. */
export function candidateAction(c: Candidate): 'add' | 'restore' {
  return c.trashedId ? 'restore' : 'add'
}
