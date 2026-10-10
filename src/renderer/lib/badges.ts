import type { PaperRow } from '../../shared/library'
import type { LlmModel } from '../../shared/summary'

export type Badge = 'problem' | 'incomplete' | 'web' | 'no_pdf' | 'summary_none' | 'to_review' | 'reviewed' | 'stale' | 'summary_failed' | 'no_citations'

export function rowBadges(row: PaperRow): Badge[] {
  if (row.problem) return ['problem']
  const badges: Badge[] = []
  if (row.metadata_status === 'incomplete') badges.push('incomplete')
  if (row.kind === 'web') badges.push('web')
  else if (!row.has_pdf) badges.push('no_pdf')
  switch (row.summary_status) {
    case 'none':
      if (row.text_status === 'ok') badges.push('summary_none')
      break
    case 'generated':
      badges.push('to_review')
      break
    case 'reviewed':
      badges.push('reviewed')
      break
    case 'stale':
      badges.push('stale')
      break
    case 'failed':
      badges.push('summary_failed')
      break
    case 'too_long':
      break
  }
  if (row.citations_status === 'unresolved') badges.push('no_citations')
  return badges
}

export type SummaryFilter = 'all' | 'none' | 'to_review' | 'reviewed' | 'stale' | 'failed'
export const SUMMARY_FILTERS: SummaryFilter[] = ['all', 'none', 'to_review', 'reviewed', 'stale', 'failed']

const SUMMARY_FILTER_STATUS: Record<Exclude<SummaryFilter, 'all'>, PaperRow['summary_status']> = {
  none: 'none',
  to_review: 'generated',
  reviewed: 'reviewed',
  stale: 'stale',
  failed: 'failed'
}

export function filterBySummary(rows: PaperRow[], filter: SummaryFilter): PaperRow[] {
  if (filter === 'all') return rows
  const status = SUMMARY_FILTER_STATUS[filter]
  return rows.filter((row) => row.summary_status === status)
}

/** Matches `row.summary_model` by family: the id contains "sonnet"/"haiku"/"opus". */
export function filterByModel(rows: PaperRow[], model: LlmModel | 'any'): PaperRow[] {
  if (model === 'any') return rows
  return rows.filter((row) => !!row.summary_model && row.summary_model.includes(model))
}

/** Rows whose id is in `ids` (e.g. a facet filter from the charts); all rows when there is no set. */
export function filterByIds(rows: PaperRow[], ids: ReadonlySet<string> | null): PaperRow[] {
  return ids ? rows.filter((row) => ids.has(row.id)) : rows
}
