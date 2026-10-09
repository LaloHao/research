import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ThesisContext, ThesisRelation } from '../../../shared/summary'
import { cardStatus } from '../../lib/summaryView'
import { CardActions, CardMeta, EvidenceList, type OpenEvidence, type Origin, type RunAction } from './FieldCard'
import { EditorButtons } from './FieldEditor'

type Questions = ThesisContext['research_questions']
type ThesisPatch = { text: string; research_questions: string[]; score: number; justification: string }

function ThesisEditor({ relation, questions, onSave, onCancel }: { relation: ThesisRelation; questions: Questions; onSave: (patch: ThesisPatch) => void; onCancel: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState(relation.text)
  const [selected, setSelected] = useState(relation.research_questions)
  const [score, setScore] = useState(relation.score)
  const [justification, setJustification] = useState(relation.justification)
  return (
    <div className="editor">
      <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      {questions.length > 0 && (
        <div className="field">
          <span>{t('summary.thesis_rqs')}</span>
          <div className="checks">
            {questions.map((q) => (
              <label key={q.id} className="row" title={q.text}>
                <input
                  type="checkbox"
                  checked={selected.includes(q.id)}
                  onChange={(e) => setSelected(e.target.checked ? [...selected, q.id] : selected.filter((id) => id !== q.id))}
                />
                {q.id}
              </label>
            ))}
          </div>
        </div>
      )}
      <select value={score} onChange={(e) => setScore(Number(e.target.value))}>
        {[1, 2, 3, 4, 5].map((n) => (
          <option key={n} value={n}>
            {t('summary.thesis_score', { score: n })}
          </option>
        ))}
      </select>
      <label className="field">
        <span>{t('summary.justification')}</span>
        <textarea rows={3} value={justification} onChange={(e) => setJustification(e.target.value)} />
      </label>
      <EditorButtons
        onSave={() => onSave({ text, research_questions: questions.map((q) => q.id).filter((id) => selected.includes(id)), score, justification })}
        onCancel={onCancel}
      />
    </div>
  )
}

/** How the paper relates to the user's thesis: text, research questions, a 1–5 score and its justification. */
export function ThesisCard({
  paperId,
  relation,
  questions,
  fallback,
  onOpenEvidence,
  run,
  outdated = false
}: {
  paperId: string
  relation: ThesisRelation
  /** Reviewed against an earlier version of the thesis. */
  outdated?: boolean
  questions: Questions
  fallback: Origin
  onOpenEvidence: OpenEvidence
  run: RunAction
}): React.JSX.Element {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const save = async (patch: ThesisPatch): Promise<void> => {
    if (await run(() => window.research.summary.edit(paperId, 'thesis', 'relation', patch))) setEditing(false)
  }
  const questionText = (id: string): string | undefined => questions.find((q) => q.id === id)?.text
  return (
    <article className={`card card-${cardStatus(relation)}`}>
      {outdated && <div className="banner warning">{t('summary.thesis_outdated')}</div>}
      {editing ? (
        <ThesisEditor relation={relation} questions={questions} onSave={save} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <p className="card-text">{relation.text || t('summary.none_value')}</p>
          {relation.research_questions.length > 0 && (
            <div className="row small">
              <span className="muted">{t('summary.thesis_rqs')}:</span>
              {relation.research_questions.map((id) => (
                <span key={id} className="chip" title={questionText(id)}>
                  {id}
                </span>
              ))}
            </div>
          )}
          <p>
            <strong>{t('summary.thesis_score', { score: relation.score })}</strong>
            {relation.justification && ` — ${relation.justification}`}
          </p>
        </>
      )}
      <CardMeta entry={relation} fallback={fallback} />
      <EvidenceList evidence={relation.evidence} onOpen={onOpenEvidence} />
      {!editing && (
        <CardActions
          status={relation.status}
          onStatus={(next) => void run(() => window.research.summary.setStatus(paperId, 'thesis', 'relation', next))}
          onEdit={() => setEditing(true)}
          reverify={outdated}
        />
      )}
    </article>
  )
}
