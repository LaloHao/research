import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { recaptureUrl } from '../../../shared/capture'
import type { ChatExcerpt } from '../../../shared/chat'
import type { PaperDetail as Detail } from '../../../shared/library'
import { useEvent } from '../../hooks/useEvent'
import { excerptFromSelection, paperChatOf, updatePaperChat, type PaperChatState } from '../../lib/chat'
import { errorText } from '../../lib/errorText'
import { paperTabs, type Tab } from '../../lib/paperTabs'
import { AttachPdfStatus, useAttachPdf } from './AttachPdf'
import { ContentView, type ContentFocus } from './ContentView'
import { MetadataCompletion } from './MetadataCompletion'
import { MetadataEditor } from './MetadataEditor'
import { NotesEditor } from './NotesEditor'
import { PdfViewer, type PdfFocus } from './PdfViewer'
import { RecaptureButton } from './Recapture'
import { RelationsTab } from './RelationsTab'
import { RemovePaper } from './RemovePaper'
import type { SelectionAskTarget } from './SelectionAsk'
import { TextTab } from './TextTab'
import { PaperChatTab } from '../chat/PaperChatTab'
import { SummaryTab } from '../summary/SummaryTab'

type Identifiers = { url?: string | null; doi?: string | null }

type PdfState = { status: 'loading' } | { status: 'ready'; data: Uint8Array } | { status: 'missing' } | { status: 'error'; message: string }

function PdfTab({
  id,
  identifiers,
  hasPdf,
  focus,
  onAsk
}: {
  id: string
  identifiers: Identifiers
  hasPdf: boolean
  focus: PdfFocus | null
  onAsk: (target: SelectionAskTarget) => boolean
}): React.JSX.Element {
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

  const missing = state.status === 'missing'
  const attach = useAttachPdf(id, !missing)
  return (
    <div className={`pdf-drop${attach.dragging ? ' dragging' : ''}`} {...attach.dropProps}>
      {state.status === 'ready' && (
        <div className="pdf-toolbar">
          <RecaptureButton id={id} identifiers={identifiers} />
          <button className="small" disabled={attach.busy} onClick={attach.pick}>
            {t('paper.attach.replace')}
          </button>
        </div>
      )}
      <AttachPdfStatus attach={attach} />
      <div className="pdf-drop-scroll">
        {state.status === 'ready' && <PdfViewer data={state.data} focus={focus} onAsk={onAsk} />}
        {state.status === 'loading' && <div className="center muted">{t('paper.pdf_loading')}</div>}
        {state.status === 'error' && <div className="center error">{t('paper.pdf_error', { message: state.message })}</div>}
        {missing && (
          <div className="center muted column">
            <p>{t('paper.no_pdf')}</p>
            <div className="row">
              <button disabled={attach.busy} onClick={attach.pick}>
                {t('paper.attach.attach')}
              </button>
              <RecaptureButton id={id} identifiers={identifiers} />
            </div>
          </div>
        )}
      </div>
      {attach.dragging && <div className="drop-overlay">{t(missing ? 'paper.attach.drop_hint' : 'paper.attach.drop_hint_replace')}</div>}
    </div>
  )
}

/** The Contenido tab of a web page without a PDF: its text, plus a way to attach one or capture it again. */
function ContentTab({
  id,
  identifiers,
  content,
  focus,
  onAsk
}: {
  id: string
  identifiers: Identifiers
  content: string
  focus: ContentFocus | null
  onAsk: (target: SelectionAskTarget) => boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const attach = useAttachPdf(id, false)
  return (
    <div className={`pdf-drop${attach.dragging ? ' dragging' : ''}`} {...attach.dropProps}>
      <div className="pdf-toolbar">
        <RecaptureButton id={id} identifiers={identifiers} />
        <button className="small" disabled={attach.busy} onClick={attach.pick}>
          {t('paper.attach.attach')}
        </button>
      </div>
      <AttachPdfStatus attach={attach} />
      <div className="pdf-drop-scroll">
        <ContentView content={content} focus={focus} onAsk={onAsk} />
      </div>
      {attach.dragging && <div className="drop-overlay">{t('paper.attach.drop_hint')}</div>}
    </div>
  )
}

export function PaperDetail({
  id,
  onOpenCandidates,
  onSelectPaper,
  onRemoved
}: {
  id: string
  onOpenCandidates?: (paperId: string) => void
  onSelectPaper?: (id: string) => void
  /** The paper went to the trash: the host closes the detail and shows «Deshacer». Without it, there is no remove button. */
  onRemoved?: (ids: string[]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [detail, setDetail] = useState<Detail | null>(null)
  // The id whose detail could not be read (deleted, or the project closed).
  const [failed, setFailed] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('summary')
  // The quote to show in the PDF after following an evidence link.
  const [focus, setFocus] = useState<PdfFocus | null>(null)
  // The quote to highlight in the Contenido tab after following an evidence link (web papers).
  const [contentFocus, setContentFocus] = useState<ContentFocus | null>(null)
  const contentFocusSeq = useRef(0)
  const [copied, setCopied] = useState(false)
  // The selection quoted in the paper's chat («Preguntar a Claude») and the conversation open there, kept while the
  // user switches tabs. Tagged with its paper: another paper sees none of it, and a late update from a paper the user
  // left (its first message answered after the switch) is ignored.
  const [chatState, setChatState] = useState<PaperChatState | null>(null)
  const shownId = useRef(id)
  shownId.current = id
  const { chatId, excerpt } = paperChatOf(chatState, id)
  const setChatId = useCallback((next: string | null) => setChatState((s) => updatePaperChat(s, id, shownId.current, { chatId: next })), [id])
  const setExcerpt = useCallback(
    (next: ChatExcerpt | null) => setChatState((s) => updatePaperChat(s, id, shownId.current, { excerpt: next })),
    [id]
  )
  /** «Preguntar a Claude»: false when the selection cannot be quoted (the button then says so). */
  const ask = useCallback(
    (target: SelectionAskTarget): boolean => {
      const next = excerptFromSelection(target.quote, id, target.page)
      if (!next) return false
      setExcerpt(next)
      setTab('chat')
      return true
    },
    [id, setExcerpt]
  )

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
  useEffect(() => {
    setFocus(null)
    setContentFocus(null)
  }, [id])
  useEvent('library-changed', refresh)
  useEvent('jobs-changed', refresh)

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
        {onRemoved && <RemovePaper id={id} title={id} onRemoved={onRemoved} />}
      </div>
    )
  }

  const tabs: Tab[] = paperTabs(detail)
  const active = tabs.includes(tab) ? tab : tabs[0]
  const link = paper.identifiers.doi ? `https://doi.org/${paper.identifiers.doi}` : paper.identifiers.url
  const authors = paper.authors.map((a) => (a.given ? `${a.given} ${a.family}` : a.family)).join(', ')
  const openEvidence = (page: number, quote: string): void => {
    if (tabs.includes('pdf')) {
      setFocus({ page, quote })
      setTab('pdf')
    } else if (tabs.includes('content')) {
      contentFocusSeq.current += 1
      setContentFocus({ quote, seq: contentFocusSeq.current })
      setTab('content')
    }
  }
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
        <MetadataEditor key={id} paper={paper} />
        {onRemoved && <RemovePaper id={id} title={paper.title} onRemoved={onRemoved} />}
      </header>
      <nav className="tabs">
        {tabs.map((name) => (
          <button key={name} className={name === active ? 'active' : ''} onClick={() => setTab(name)}>
            {t(`paper.tabs.${name}`)}
          </button>
        ))}
      </nav>
      <div className="tab-body">
        {active === 'summary' && <SummaryTab key={detail.id} detail={detail} onOpenEvidence={openEvidence} />}
        {/* Keyed by the PDF hash too, so a replaced PDF is loaded again. */}
        {active === 'pdf' && <PdfTab key={`${id}:${paper.pdf_sha256 ?? ''}`} id={id} identifiers={paper.identifiers} hasPdf={detail.hasPdf} focus={focus} onAsk={ask} />}
        {active === 'text' && <TextTab key={id} id={id} />}
        {active === 'content' &&
          (detail.hasPdf ? (
            <div key={id} className="pdf-drop">
              {recaptureUrl(paper.identifiers) && (
                <div className="pdf-toolbar">
                  <RecaptureButton id={id} identifiers={paper.identifiers} />
                </div>
              )}
              <div className="pdf-drop-scroll">
                <ContentView content={detail.content ?? ''} focus={contentFocus} onAsk={ask} />
              </div>
            </div>
          ) : (
            <ContentTab key={id} id={id} identifiers={paper.identifiers} content={detail.content ?? ''} focus={contentFocus} onAsk={ask} />
          ))}
        {active === 'relations' && (
          <RelationsTab key={id} paperId={id} title={paper.title} onOpenEvidence={openEvidence} onOpenCandidates={onOpenCandidates} onSelectPaper={onSelectPaper} />
        )}
        {active === 'chat' && (
          <PaperChatTab key={id} paperId={id} selected={chatId} onSelectedChange={setChatId} excerpt={excerpt} onExcerptChange={setExcerpt} />
        )}
        {active === 'notes' && <NotesEditor key={id} paperId={id} />}
      </div>
    </div>
  )
}
