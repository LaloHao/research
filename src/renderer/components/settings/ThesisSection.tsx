import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ThesisContext } from '../../../shared/summary'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { nextRqId } from '../../lib/thesis'

const EMPTY: ThesisContext = { title: '', description: '', research_questions: [] }

export function ThesisSection(): React.JSX.Element {
  const { t } = useTranslation()
  const [thesis, setThesis] = useState<ThesisContext>(EMPTY)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    window.research.thesis.get().then(setThesis, () => undefined)
  }, [])
  useEffect(load, [load])
  useEvent('project-changed', load)

  const save = (next: ThesisContext): void => {
    setError(null)
    window.research.thesis.update(next).then(
      (result) => {
        if (!result.ok) setError(errorText(t, result.error))
      },
      () => setError(errorText(t, 'unknown'))
    )
  }

  const updateRq = (index: number, text: string): void => {
    setThesis({ ...thesis, research_questions: thesis.research_questions.map((q, i) => (i === index ? { ...q, text } : q)) })
  }
  const removeRq = (index: number): void => {
    const next = { ...thesis, research_questions: thesis.research_questions.filter((_, i) => i !== index) }
    setThesis(next)
    save(next)
  }
  const addRq = (): void => {
    setThesis({ ...thesis, research_questions: [...thesis.research_questions, { id: nextRqId(thesis.research_questions), text: '' }] })
  }

  return (
    <section className="thesis-section">
      <p className="muted small">{t('settings.thesis_help')}</p>
      {error && <div className="banner error">{error}</div>}
      <label className="field">
        <span>{t('settings.thesis_title')}</span>
        <input value={thesis.title} onChange={(e) => setThesis({ ...thesis, title: e.target.value })} onBlur={() => save(thesis)} />
      </label>
      <label className="field">
        <span>{t('settings.thesis_description')}</span>
        <textarea rows={5} value={thesis.description} onChange={(e) => setThesis({ ...thesis, description: e.target.value })} onBlur={() => save(thesis)} />
      </label>
      <div className="field">
        <span>{t('settings.thesis_rqs')}</span>
        {thesis.research_questions.map((q, i) => (
          <div className="row" key={i}>
            <input value={q.text} onChange={(e) => updateRq(i, e.target.value)} onBlur={() => save(thesis)} />
            <button onClick={() => removeRq(i)}>{t('settings.thesis_remove_rq')}</button>
          </div>
        ))}
        <button onClick={addRq}>{t('settings.thesis_add_rq')}</button>
      </div>
    </section>
  )
}
