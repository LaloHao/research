import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MAX_CHECK_CHARS, type WritingLibrary } from '../../../shared/writing/api'
import { detectFormat, parseCitations, resolveCitations, type CiteFormat, type ResolvedCitation } from '../../../shared/writing/citations'
import { keyIndexOf } from '../../lib/writing'
import { CheckWithClaude } from './CheckWithClaude'
import { InputFormat } from './OutputFormat'

/**
 * «Verificar citas», the local step (free and immediate): the citations of pasted text with their sentences, and the
 * keys that cannot be checked (unknown, in the trash, without indexed text) or are cited twice. Claude's check of
 * each sentence against the cited papers comes after it, in CheckWithClaude.
 */
export function CheckTab({ library }: { library: WritingLibrary | null }): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [format, setFormat] = useState<CiteFormat | 'auto'>('auto')
  const detected = useMemo(() => detectFormat(text), [text])
  const used = format === 'auto' ? detected : format
  const tooLong = text.length > MAX_CHECK_CHARS
  const report = useMemo(() => {
    if (!library || tooLong || !text.trim()) return null
    return resolveCitations(parseCitations(text, used), keyIndexOf(library))
  }, [library, text, used, tooLong])

  return (
    <section className="writing-tab">
      <p className="muted">{t('writing.check.intro')}</p>
      <div className="row">
        <InputFormat value={format} detected={detected} onChange={setFormat} />
        <span className={`small ${tooLong ? 'error' : 'muted'}`}>{t('writing.check.chars', { length: text.length, max: MAX_CHECK_CHARS })}</span>
      </div>
      <textarea
        className="writing-input"
        aria-label={t('writing.check.text_label')}
        placeholder={t('writing.check.placeholder')}
        value={text}
        aria-invalid={tooLong || undefined}
        onChange={(e) => setText(e.target.value)}
      />
      {tooLong && (
        <div className="banner error" role="alert">
          {t('writing.check.too_long', { max: MAX_CHECK_CHARS })}
        </div>
      )}
      {report && (
        <>
          <p role="status">
            {t('writing.check.summary', { count: report.citations.length, keys: report.keys.length })}
            {report.unknown.length > 0 && ` · ${t('writing.check.count_unknown', { count: report.unknown.length })}`}
            {report.trashed.length > 0 && ` · ${t('writing.check.count_trashed', { count: report.trashed.length })}`}
            {report.noText.length > 0 && ` · ${t('writing.check.count_no_text', { count: report.noText.length })}`}
            {report.duplicates.length > 0 && ` · ${t('writing.check.count_duplicates', { count: report.duplicates.length })}`}
          </p>
          {report.citations.length === 0 ? (
            <p className="muted">{t('writing.check.none')}</p>
          ) : (
            <ol className="writing-citations">
              {report.citations.map((c) => (
                <CitationRow key={c.start} citation={c} />
              ))}
            </ol>
          )}
        </>
      )}
      <CheckWithClaude report={report} text={text} format={used} />
    </section>
  )
}

function CitationRow({ citation }: { citation: ResolvedCitation }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <li className="writing-citation">
      <div className="writing-sentence">{citation.sentence.text}</div>
      <div className="chip-list">
        {citation.keys.map((key, i) => {
          const state = citation.states[key]
          return (
            <span key={`${key}-${i}`} className={`chip writing-key-${state}`} title={t(`writing.key_state.${state}`)}>
              {key}
              {citation.items[i]?.page ? `, p. ${citation.items[i].page}` : ''}
              {state !== 'ok' && ` · ${t(`writing.key_state.${state}`)}`}
            </span>
          )
        })}
        {citation.duplicates.map((key) => (
          <span key={`dup-${key}`} className="chip writing-key-duplicate">
            {t('writing.check.duplicate', { key })}
          </span>
        ))}
      </div>
    </li>
  )
}
