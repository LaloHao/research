import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActionResult } from '../../../shared/ipc'
import type { Evidence, FieldStatus, Provenance, SummaryFields } from '../../../shared/summary'
import { cardStatus, type FieldCardData } from '../../lib/summaryView'
import { FieldEditor } from './FieldEditor'

export type OpenEvidence = (page: number, quote: string) => void
/** Runs a mutation and shows its error, if any. */
export type RunAction = (action: () => Promise<ActionResult>) => Promise<boolean>
/** The model and date of the whole summary, used when an entry has no `origin` of its own. */
export type Origin = Pick<Provenance, 'model' | 'at'>

export const formatDate = (at: string): string => {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleDateString()
}

/** Status chip and "generated with …" line shared by every card. */
export function CardMeta({ entry, fallback }: { entry: { status: FieldStatus; evidence: Evidence[]; origin?: Provenance }; fallback: Origin }): React.JSX.Element {
  const { t } = useTranslation()
  const status = cardStatus(entry)
  const origin = entry.origin ?? fallback
  return (
    <div className="row small card-meta">
      <span className={`chip chip-${status}`}>{t(`summary.status.${status}`)}</span>
      <span className="muted">{t('summary.generated_with', { model: origin.model, date: formatDate(origin.at) })}</span>
    </div>
  )
}

export function EvidenceList({ evidence, onOpen }: { evidence: Evidence[]; onOpen: OpenEvidence }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (evidence.length === 0) return null
  return (
    <ul className="evidence">
      {evidence.map((e, i) => (
        <li key={i} className={e.found ? '' : 'not-found'}>
          <q>{e.quote}</q>{' '}
          {e.page !== null && (
            <button className="link small" onClick={() => onOpen(e.page!, e.quote)}>
              {t('summary.evidence_page', { page: e.page })}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

/** Verify / unverify and edit; an edited entry is already the user's own and needs no verification. */
export function CardActions({ status, onStatus, onEdit }: { status: FieldStatus; onStatus: (next: 'verified' | 'generated') => void; onEdit: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="row card-actions">
      {status === 'generated' && (
        <button className="small" onClick={() => onStatus('verified')}>
          {t('summary.verify')}
        </button>
      )}
      {status === 'verified' && (
        <button className="small" onClick={() => onStatus('generated')}>
          {t('summary.unverify')}
        </button>
      )}
      <button className="small" onClick={onEdit}>
        {t('summary.edit')}
      </button>
    </div>
  )
}

function FieldValue({ card }: { card: FieldCardData }): React.JSX.Element {
  const { t } = useTranslation()
  if (card.key === 'research_type') return <p>{t(`summary.research_types.${card.entry.value}`)}</p>
  if (card.key === 'limitations') {
    const lists: [string, string[]][] = [
      [t('summary.stated'), card.entry.value.stated],
      [t('summary.inferred'), card.entry.value.inferred]
    ]
    return (
      <div className="limitations">
        {lists.map(([label, items]) => (
          <div key={label}>
            <h5>{label}</h5>
            {items.length ? (
              <ul>
                {items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t('summary.none_value')}</p>
            )}
          </div>
        ))}
      </div>
    )
  }
  return <p className="card-text">{card.entry.value || t('summary.none_value')}</p>
}

export function FieldCard({
  paperId,
  card,
  fallback,
  onOpenEvidence,
  run
}: {
  paperId: string
  card: FieldCardData
  fallback: Origin
  onOpenEvidence: OpenEvidence
  run: RunAction
}): React.JSX.Element {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const status = cardStatus(card.entry)
  const save = async (value: SummaryFields[typeof card.key]['value']): Promise<void> => {
    if (await run(() => window.research.summary.edit(paperId, 'fields', card.key, value))) setEditing(false)
  }
  return (
    <article className={`card card-${status}`}>
      <h4>{t(`summary.fields.${card.key}`)}</h4>
      {editing ? <FieldEditor card={card} onSave={save} onCancel={() => setEditing(false)} /> : <FieldValue card={card} />}
      <CardMeta entry={card.entry} fallback={fallback} />
      <EvidenceList evidence={card.entry.evidence} onOpen={onOpenEvidence} />
      {!editing && (
        <CardActions
          status={card.entry.status}
          onStatus={(next) => void run(() => window.research.summary.setStatus(paperId, 'fields', card.key, next))}
          onEdit={() => setEditing(true)}
        />
      )}
    </article>
  )
}
