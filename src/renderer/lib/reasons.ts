import type { TFunction } from 'i18next'
import type { SimilarityReason } from '../../shared/relations'

export function reasonText(t: TFunction, reason: SimilarityReason): string {
  switch (reason.kind) {
    case 'coupling':
      return t('relations.reasons.coupling', { count: reason.shared })
    case 'cocitation':
      return t('relations.reasons.cocitation', { count: reason.by })
    case 'direct':
      return t('relations.reasons.direct', { citing: reason.citing, cited: reason.cited })
    case 'content':
      return t('relations.reasons.content', { score: reason.cosine.toFixed(2) })
    case 'facets':
      // Facet keys and values are shown as the form defines them.
      return reason.shared.map((s) => `${s.facet}: ${s.values.join(', ')}`).join(' · ')
  }
}

export function reasonsText(t: TFunction, reasons: SimilarityReason[]): string {
  return reasons.map((r) => reasonText(t, r)).join(' · ')
}
