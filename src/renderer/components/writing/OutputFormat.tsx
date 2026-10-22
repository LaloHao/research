import { useTranslation } from 'react-i18next'
import { CITE_FORMATS, type CiteFormat } from '../../../shared/writing/citations'
import { LATEX_OUTPUT_COMMANDS, type LatexOutputCommand } from '../../../shared/writing/convert'
import type { WritingPrefs } from '../../lib/writing'

/** The output format (Org, LaTeX, Markdown) and, for LaTeX, the citation command. */
export function OutputFormat({ prefs, onChange }: { prefs: WritingPrefs; onChange: (prefs: WritingPrefs) => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="row">
      <label className="row">
        <span>{t('writing.format.label')}</span>
        <select value={prefs.format} onChange={(e) => onChange({ ...prefs, format: e.target.value as CiteFormat })}>
          {CITE_FORMATS.map((f) => (
            <option key={f} value={f}>
              {t(`writing.format.formats.${f}`)}
            </option>
          ))}
        </select>
      </label>
      {prefs.format === 'latex' && (
        <label className="row">
          <span>{t('writing.format.command')}</span>
          <select value={prefs.latexCommand} onChange={(e) => onChange({ ...prefs, latexCommand: e.target.value as LatexOutputCommand })}>
            {LATEX_OUTPUT_COMMANDS.map((c) => (
              <option key={c} value={c}>
                {`\\${c}`}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}

/** The input format of pasted text: detected, or the one the user picks. */
export function InputFormat({ value, detected, onChange }: { value: CiteFormat | 'auto'; detected: CiteFormat; onChange: (value: CiteFormat | 'auto') => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <label className="row">
      <span>{t('writing.format.input')}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as CiteFormat | 'auto')}>
        <option value="auto">{t('writing.format.auto', { format: t(`writing.format.formats.${detected}`) })}</option>
        {CITE_FORMATS.map((f) => (
          <option key={f} value={f}>
            {t(`writing.format.formats.${f}`)}
          </option>
        ))}
      </select>
    </label>
  )
}
