import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FacetDef, FormInfo } from '../../../shared/summary'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'

function facetValues(facet: FacetDef): string {
  switch (facet.type) {
    case 'single':
    case 'multi':
      return facet.values.join(', ')
    case 'scale':
      return `${facet.min}–${facet.max}`
    case 'text':
      return ''
  }
}

export function ExtractionFormView(): React.JSX.Element {
  const { t } = useTranslation()
  const [form, setForm] = useState<FormInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    window.research.llm.info().then((info) => setForm(info.form), () => undefined)
  }, [])
  useEffect(load, [load])
  useEvent('project-changed', load)

  const createDefault = (): void => {
    setError(null)
    window.research.llm.createForm().then(
      (result) => {
        if (!result.ok) setError(errorText(t, result.error))
      },
      () => setError(errorText(t, 'unknown'))
    )
  }

  if (!form) return <section className="extraction-form" />

  return (
    <section className="extraction-form">
      <h3>{t('settings.form_section')}</h3>
      {error && <div className="banner error">{error}</div>}
      {form.status === 'missing' && (
        <div>
          <p className="muted">{t('settings.form_missing')}</p>
          <button className="primary" onClick={createDefault}>
            {t('settings.form_create')}
          </button>
        </div>
      )}
      {form.status === 'invalid' && (
        <div>
          <p>{t('settings.form_invalid')}</p>
          <ul>
            {form.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {form.status === 'ok' && (
        <>
          <table className="extraction-table">
            <thead>
              <tr>
                <th>{t('settings.form_columns.key')}</th>
                <th>{t('settings.form_columns.type')}</th>
                <th>{t('settings.form_columns.description')}</th>
                <th>{t('settings.form_columns.values')}</th>
                <th>{t('settings.form_columns.aliases')}</th>
              </tr>
            </thead>
            <tbody>
              {form.form.facets.map((facet) => (
                <tr key={facet.key}>
                  <td>{facet.key}</td>
                  <td>{facet.type}</td>
                  <td>{facet.description}</td>
                  <td>{facetValues(facet)}</td>
                  <td>
                    {Object.entries(form.form.value_aliases[facet.key] ?? {})
                      .map(([from, to]) => `${from} → ${to}`)
                      .join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={() => void window.research.llm.showProjectFile()}>{t('settings.form_show_file')}</button>
        </>
      )}
    </section>
  )
}
