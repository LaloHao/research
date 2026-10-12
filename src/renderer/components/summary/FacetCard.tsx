import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FacetDef, FacetEntry } from '../../../shared/summary'
import { cardStatus, facetValueText } from '../../lib/summaryView'
import { CardActions, CardMeta, EvidenceList, type OpenEvidence, type Origin, type RunAction } from './FieldCard'
import { EditorButtons } from './FieldEditor'
import { ProposedChip } from './ProposedChip'

type FacetPatch = { value?: string | null; values?: string[]; text?: string; score?: number; justification?: string }

const range = (min: number, max: number): number[] => Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i)

function FacetEditor({ def, entry, onSave, onCancel }: { def: FacetDef; entry: FacetEntry | null; onSave: (patch: FacetPatch) => void; onCancel: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [values, setValues] = useState<string[]>(entry?.values ?? [])
  const [value, setValue] = useState(entry?.value ?? '')
  const [text, setText] = useState(entry?.text ?? '')
  const [score, setScore] = useState(entry?.score ?? (def.type === 'scale' ? def.min : 0))
  const [justification, setJustification] = useState(entry?.justification ?? '')

  let body: React.JSX.Element
  let patch: () => FacetPatch
  switch (def.type) {
    case 'multi':
      body = (
        <div className="checks">
          {def.values.map((v) => (
            <label key={v} className="row">
              <input
                type="checkbox"
                checked={values.includes(v)}
                onChange={(e) => setValues(e.target.checked ? [...values, v] : values.filter((x) => x !== v))}
              />
              {v}
            </label>
          ))}
        </div>
      )
      patch = () => ({ values: def.values.filter((v) => values.includes(v)) })
      break
    case 'single':
      body = (
        <select value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">{t('summary.none_value')}</option>
          {def.values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      )
      patch = () => ({ value: value || null })
      break
    case 'text':
      body = <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      patch = () => ({ text })
      break
    case 'scale':
      body = (
        <>
          <select value={score} onChange={(e) => setScore(Number(e.target.value))}>
            {range(def.min, def.max).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <label className="field">
            <span>{t('summary.justification')}</span>
            <textarea rows={3} value={justification} onChange={(e) => setJustification(e.target.value)} />
          </label>
        </>
      )
      patch = () => ({ score, justification })
      break
  }
  return (
    <div className="editor">
      {body}
      <EditorButtons onSave={() => onSave(patch())} onCancel={onCancel} />
    </div>
  )
}

export function FacetCard({
  paperId,
  def,
  entry,
  fallback,
  onOpenEvidence,
  run,
  unfilled = false
}: {
  paperId: string
  def: FacetDef
  entry: FacetEntry | null
  fallback: Origin
  onOpenEvidence: OpenEvidence
  run: RunAction
  /** A facet added to the form after this up-to-date summary was made: «Faceta nueva sin llenar». */
  unfilled?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const status = entry ? cardStatus(entry) : null
  const save = async (patch: FacetPatch): Promise<void> => {
    if (await run(() => window.research.summary.edit(paperId, 'facets', def.key, patch))) setEditing(false)
  }
  const allowed = 'values' in def ? def.values : []
  return (
    <article className={`card${status ? ` card-${status}` : ''}`}>
      <h4>
        <code>{def.key}</code>
      </h4>
      <p className="muted small">{def.description}</p>
      {editing ? (
        <FacetEditor def={def} entry={entry} onSave={save} onCancel={() => setEditing(false)} />
      ) : !entry && unfilled ? (
        <p className="muted">{t('facets.unfilled')}</p>
      ) : (
        <p className="card-text">{facetValueText(def, entry)}</p>
      )}
      {entry && entry.proposed.length > 0 && allowed.length > 0 && (
        <div className="proposals">
          {entry.proposed.map((p) => (
            <ProposedChip key={p} facetKey={def.key} value={p} allowed={allowed} run={run} />
          ))}
        </div>
      )}
      {entry && <CardMeta entry={entry} fallback={fallback} />}
      {entry && <EvidenceList evidence={entry.evidence} onOpen={onOpenEvidence} />}
      {!editing && (
        <CardActions
          status={entry?.status ?? 'edited'}
          onStatus={(next) => void run(() => window.research.summary.setStatus(paperId, 'facets', def.key, next))}
          onEdit={() => setEditing(true)}
        />
      )}
    </article>
  )
}
