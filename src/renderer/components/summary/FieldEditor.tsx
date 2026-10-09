import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RESEARCH_TYPES, type SummaryFields } from '../../../shared/summary'
import type { FieldCardData } from '../../lib/summaryView'

type Value = SummaryFields[keyof SummaryFields]['value']

const toLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

export function EditorButtons({ onSave, onCancel }: { onSave: () => void; onCancel: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="row">
      <button className="small primary" onClick={onSave}>
        {t('summary.save')}
      </button>
      <button className="small" onClick={onCancel}>
        {t('summary.cancel')}
      </button>
    </div>
  )
}

/** Edits one summary field: text in a textarea, limitations as one item per line, the research type from a list. */
export function FieldEditor({ card, onSave, onCancel }: { card: FieldCardData; onSave: (value: Value) => void; onCancel: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState(typeof card.entry.value === 'string' ? card.entry.value : '')
  const [stated, setStated] = useState(card.key === 'limitations' ? card.entry.value.stated.join('\n') : '')
  const [inferred, setInferred] = useState(card.key === 'limitations' ? card.entry.value.inferred.join('\n') : '')

  if (card.key === 'research_type') {
    return (
      <div className="editor">
        <select value={text} onChange={(e) => setText(e.target.value)}>
          {RESEARCH_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`summary.research_types.${type}`)}
            </option>
          ))}
        </select>
        <EditorButtons onSave={() => onSave(text as Value)} onCancel={onCancel} />
      </div>
    )
  }
  if (card.key === 'limitations') {
    return (
      <div className="editor">
        <label className="field">
          <span>{t('summary.stated')}</span>
          <textarea rows={4} value={stated} onChange={(e) => setStated(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('summary.inferred')}</span>
          <textarea rows={4} value={inferred} onChange={(e) => setInferred(e.target.value)} />
        </label>
        <EditorButtons onSave={() => onSave({ stated: toLines(stated), inferred: toLines(inferred) })} onCancel={onCancel} />
      </div>
    )
  }
  return (
    <div className="editor">
      <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      <EditorButtons onSave={() => onSave(text)} onCancel={onCancel} />
    </div>
  )
}
