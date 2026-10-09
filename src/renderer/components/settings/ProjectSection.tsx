import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectInfo } from '../../../shared/ipc'
import { PDF_POLICIES, type PdfPolicy } from '../../../shared/schemas'

const CONTENT_LANGUAGES = ['en', 'es'] as const

export function ProjectSection({ project, onSaved }: { project: ProjectInfo; onSaved: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState(project.name)

  useEffect(() => setName(project.name), [project.name])

  const update = (patch: { name?: string; contentLanguage?: string; pdfPolicy?: PdfPolicy }): void => {
    void window.research.project.update(patch).then(onSaved)
  }

  return (
    <section>
      <label className="field">
        <span>{t('settings.project_name')}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim() && name.trim() !== project.name) update({ name: name.trim() })
          }}
        />
      </label>
      <div className="field">
        <span>{t('settings.project_folder')}</span>
        <code>{project.root}</code>
      </div>
      <label className="field">
        <span>{t('settings.content_language')}</span>
        <select value={project.contentLanguage} onChange={(e) => update({ contentLanguage: e.target.value })}>
          {CONTENT_LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {t(`settings.languages.${l}`)}
            </option>
          ))}
        </select>
        <small className="muted">{t('settings.content_language_help')}</small>
      </label>
      <label className="field">
        <span>{t('settings.pdf_policy_label')}</span>
        <select value={project.pdfPolicy} onChange={(e) => update({ pdfPolicy: e.target.value as PdfPolicy })}>
          {PDF_POLICIES.map((p) => (
            <option key={p} value={p}>
              {t(`settings.pdf_policy.${p}`)}
            </option>
          ))}
        </select>
        <small className="muted">{t('settings.pdf_policy_help')}</small>
      </label>
    </section>
  )
}
