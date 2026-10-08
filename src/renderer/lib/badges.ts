import type { PaperRow } from '../../shared/library'

export type Badge = 'problem' | 'incomplete' | 'web' | 'no_pdf'

export function rowBadges(row: PaperRow): Badge[] {
  if (row.problem) return ['problem']
  const badges: Badge[] = []
  if (row.metadata_status === 'incomplete') badges.push('incomplete')
  if (row.kind === 'web') badges.push('web')
  else if (!row.has_pdf) badges.push('no_pdf')
  return badges
}
