import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ImportChoice } from '../../../shared/ipc'
import { MAX_BIB_TEXT_CHARS, type ChapterBib } from '../../../shared/writing/api'
import { BIB_ORDERS, chapterBibText, type BibOrder } from '../../../shared/writing/bibtex'
import { detectFormat, type CiteFormat } from '../../../shared/writing/citations'
import { errorText } from '../../lib/errorText'
import { exportFileName } from '../../lib/writing'
import { InputFormat } from './OutputFormat'

type Source = 'file' | 'text'

/**
 * «BibTeX» (no Claude): a .bib with only the library entries a chapter cites. The file is picked in the main process's
 * dialog, which follows its includes inside its own folder; pasted text is read as it is.
 */
export function BibtexTab(): React.JSX.Element {
  const { t } = useTranslation()
  const [source, setSource] = useState<Source>('file')
  const [file, setFile] = useState<ImportChoice | null>(null)
  const [text, setText] = useState('')
  const [format, setFormat] = useState<CiteFormat | 'auto'>('auto')
  const detected = useMemo(() => detectFormat(text), [text])
  const [order, setOrder] = useState<BibOrder>('appearance')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ bib: ChapterBib; name: string } | null>(null)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const bibText = useMemo(() => (result ? chapterBibText(result.bib.report, order) : ''), [result, order])

  const choose = (): void => {
    if (busy) return
    window.research.writing.chooseFile().then(
      (picked) => {
        if (picked) {
          setFile(picked)
          setNotice(null)
        }
      },
      () => setNotice({ error: true, text: errorText(t, 'unknown') })
    )
  }

  const generate = (): void => {
    if (busy) return
    const request =
      source === 'file' ? (file ? ({ kind: 'file', token: file.token } as const) : null) : text.trim() ? ({ kind: 'text', text, format: format === 'auto' ? detected : format } as const) : null
    if (!request) return
    const name = source === 'file' && file ? file.name : t('writing.bibtex.default_name')
    // The token names the file once: generating again needs the file picked again.
    if (source === 'file') setFile(null)
    setBusy(true)
    setNotice(null)
    window.research.writing.bibtex(request).then(
      (r) => {
        setBusy(false)
        if (r.ok) setResult({ bib: r.bib, name })
        else setNotice({ error: true, text: errorText(t, r.error) })
      },
      () => {
        setBusy(false)
        setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  const save = async (): Promise<void> => {
    if (!result) return
    try {
      const r = await window.research.exports.save(exportFileName(result.name, 'bib'), bibText)
      if (r.ok) setNotice({ error: false, text: t('writing.saved', { path: r.path }) })
      else if (r.error) setNotice({ error: true, text: errorText(t, r.error) })
    } catch {
      setNotice({ error: true, text: errorText(t, 'unknown') })
    }
  }

  const copy = (): void => {
    navigator.clipboard.writeText(bibText).then(
      () => setNotice({ error: false, text: t('writing.copied') }),
      () => setNotice({ error: true, text: errorText(t, 'unknown') })
    )
  }

  const tooLong = text.length > MAX_BIB_TEXT_CHARS
  const ready = source === 'file' ? file !== null : text.trim() !== '' && !tooLong

  return (
    <section className="writing-tab">
      <p className="muted">{t('writing.bibtex.intro')}</p>
      <div className="row" role="radiogroup" aria-label={t('writing.bibtex.source')}>
        {(['file', 'text'] as const).map((s) => (
          <label key={s} className="row">
            <input type="radio" name="bib-source" checked={source === s} onChange={() => setSource(s)} />
            <span>{t(`writing.bibtex.sources.${s}`)}</span>
          </label>
        ))}
      </div>
      {source === 'file' ? (
        <div className="row">
          <button disabled={busy} onClick={choose}>
            {t('writing.bibtex.choose')}
          </button>
          <span className="muted">{file ? file.name : t('writing.bibtex.no_file')}</span>
        </div>
      ) : (
        <>
          <InputFormat value={format} detected={detected} onChange={setFormat} />
          <textarea className="writing-input" aria-label={t('writing.bibtex.text_label')} placeholder={t('writing.bibtex.placeholder')} value={text} onChange={(e) => setText(e.target.value)} />
          {tooLong && (
            <div className="banner error" role="alert">
              {t('writing.bibtex.too_long')}
            </div>
          )}
        </>
      )}
      <div className="row">
        <label className="row">
          <span>{t('writing.bibtex.order')}</span>
          <select value={order} onChange={(e) => setOrder(e.target.value as BibOrder)}>
            {BIB_ORDERS.map((o) => (
              <option key={o} value={o}>
                {t(`writing.bibtex.orders.${o}`)}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" disabled={busy || !ready} onClick={generate}>
          {busy ? t('writing.bibtex.generating') : t('writing.bibtex.generate')}
        </button>
      </div>
      {notice && (
        <div className={`banner${notice.error ? ' error' : ''}`} role="status">
          {notice.text}
        </div>
      )}
      {result && <BibReport bib={result.bib} />}
      {result && (
        <>
          <div className="row">
            <button onClick={() => void save()}>{t('writing.bibtex.save')}</button>
            <button onClick={copy}>{t('writing.copy')}</button>
          </div>
          <textarea className="writing-output" readOnly aria-label={t('writing.bibtex.output_label')} value={bibText} />
        </>
      )}
    </section>
  )
}

function BibReport({ bib }: { bib: ChapterBib }): React.JSX.Element {
  const { t } = useTranslation()
  const { report } = bib
  return (
    <div className="writing-report">
      <p role="status">{t('writing.bibtex.summary', { count: report.keys.length, entries: report.entries.length, citations: bib.citations })}</p>
      {bib.files.length > 1 && (
        <details>
          <summary>{t('writing.bibtex.files', { count: bib.files.length })}</summary>
          <ul className="small">
            {bib.files.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code> · {t('writing.bibtex.file_citations', { count: f.citations })}
              </li>
            ))}
          </ul>
        </details>
      )}
      {bib.skipped.length > 0 && (
        <div className="banner warning">
          <strong>{t('writing.bibtex.skipped_title')}</strong>
          <ul className="small">
            {bib.skipped.map((s, i) => (
              <li key={i}>
                <code>{s.path}</code> ({t('writing.bibtex.in_file', { file: s.from })}): {t(`writing.bibtex.skip_reasons.${s.reason}`)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.unknown.length > 0 && (
        <div className="banner warning">
          <strong>{t('writing.bibtex.unknown_title', { count: report.unknown.length })}</strong>
          <ul className="small">
            {report.unknown.map((u) => (
              <li key={u.key}>
                <code>{u.key}</code>
                {u.suggestion && ` · ${t('writing.bibtex.suggestion', { key: u.suggestion.key, title: u.suggestion.title })}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.trashed.length > 0 && (
        <div className="banner warning">
          <strong>{t('writing.bibtex.trashed_title', { count: report.trashed.length })}</strong> {report.trashed.join(', ')}
        </div>
      )}
      {report.invalid.length > 0 && (
        <div className="banner warning">
          <strong>{t('writing.bibtex.invalid_title', { count: report.invalid.length })}</strong> {report.invalid.join(', ')}
        </div>
      )}
      {report.incomplete.length > 0 && (
        <details>
          <summary>{t('writing.bibtex.incomplete_title', { count: report.incomplete.length })}</summary>
          <ul className="small">
            {report.incomplete.map((e) => (
              <li key={e.key}>
                <code>{e.key}</code>: {e.missing.map((f) => t(`writing.bibtex.fields.${f}`)).join(', ')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
