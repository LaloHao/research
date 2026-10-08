import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PaperDetail as Detail } from '../../../shared/library'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { paperTabs, type Tab } from '../../lib/paperTabs'
import { MetadataCompletion } from './MetadataCompletion'
import { NotesEditor } from './NotesEditor'
import { PdfViewer } from './PdfViewer'

type PdfState = { status: 'loading' } | { status: 'ready'; data: Uint8Array } | { status: 'missing' } | { status: 'error'; message: string }

function PdfTab({ id, hasPdf }: { id: string; hasPdf: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const [state, setState] = useState<PdfState>({ status: 'loading' })
  useEffect(() => {
    if (!hasPdf) {
      setState({ status: 'missing' })
      return
    }
    let alive = true
    setState({ status: 'loading' })
    window.research.library.readPdf(id).then(
      (result) => {
        if (!alive) return
        if (!result.ok) setState({ status: 'error', message: errorText(t, result.error) })
        else setState(result.data ? { status: 'ready', data: result.data } : { status: 'missing' })
      },
      () => {
        if (alive) setState({ status: 'error', message: errorText(t, 'unknown') })
      }
    )
    return () => {
      alive = false
    }
  }, [id, hasPdf, t])

  if (state.status === 'ready') return <PdfViewer data={state.data} />
  if (state.status === 'loading') return <div className="center muted">{t('paper.pdf_loading')}</div>
  if (state.status === 'error') return <div className="center error">{t('paper.pdf_error', { message: state.message })}</div>
  return <div className="center muted">{t('paper.no_pdf')}</div>
}

export function PaperDetail({ id }: { id: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [detail, setDetail] = useState<Detail | null>(null)
  // The id whose detail could not be read (deleted, or the project closed).
  const [failed, setFailed] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('pdf')
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(() => {
    window.research.library.detail(id).then(
      (next) => {
        setDetail(next)
        setFailed(null)
      },
      () => setFailed(id)
    )
  }, [id])
  useEffect(refresh, [refresh])
  useEvent('library-changed', refresh)

  if (failed === id) return <div className="center muted">{t('paper.not_found')}</div>
  if (!detail || detail.id !== id) return <div className="center muted">{t('app.loading')}</div>
  const { paper } = detail
  if (!paper) {
    return (
      <div className="paper-header">
        <div className="banner error">
          <strong>{t('paper.problem_title')}</strong>
          {detail.problemKind && <p>{t(`paper.problem_kinds.${detail.problemKind}`)}</p>}
          <details>
            <summary>{t('paper.problem_details')}</summary>
            <pre>{detail.problem}</pre>
          </details>
        </div>
        <button onClick={() => void window.research.library.showInFolder(id)}>{t('paper.show_in_folder')}</button>
      </div>
    )
  }

  const tabs: Tab[] = paperTabs(detail)
  const active = tabs.includes(tab) ? tab : tabs[0]
  const link = paper.identifiers.doi ? `https://doi.org/${paper.identifiers.doi}` : paper.identifiers.url
  const authors = paper.authors.map((a) => (a.given ? `${a.given} ${a.family}` : a.family)).join(', ')
  const copyKey = (): void => {
    void navigator.clipboard.writeText(paper.id).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="paper-detail">
      <header className="paper-header">
        <h2>{paper.title}</h2>
        <p className="muted">{[authors, paper.year, paper.venue].filter(Boolean).join(' · ')}</p>
        <div className="row small">
          <span className="muted">{t('paper.cite_key')}:</span>
          <code>{paper.id}</code>
          <button className="small" onClick={copyKey}>
            {copied ? t('paper.copied') : t('paper.copy_key')}
          </button>
          {link && (
            <a href={link} target="_blank" rel="noreferrer">
              {t('paper.open_link')}
            </a>
          )}
          <button className="small" onClick={() => void window.research.library.showInFolder(id)}>
            {t('paper.show_in_folder')}
          </button>
          <span className="muted">{t(`text_status.${detail.textStatus}`)}</span>
        </div>
        {paper.metadata_status === 'incomplete' && (
          <MetadataCompletion paperId={id} hasIdentifier={Boolean(paper.identifiers.doi || paper.identifiers.arxiv)} />
        )}
      </header>
      <nav className="tabs">
        {tabs.map((name) => (
          <button key={name} className={name === active ? 'active' : ''} onClick={() => setTab(name)}>
            {t(`paper.tabs.${name}`)}
          </button>
        ))}
      </nav>
      <div className="tab-body">
        {active === 'pdf' && <PdfTab key={id} id={id} hasPdf={detail.hasPdf} />}
        {active === 'content' && <pre className="content">{detail.content}</pre>}
        {active === 'notes' && <NotesEditor key={id} paperId={id} />}
      </div>
    </div>
  )
}
