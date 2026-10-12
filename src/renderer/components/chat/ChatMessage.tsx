import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Markdown, { type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AssistantView, ChatCitation, ChatExcerpt, UserMessage } from '../../../shared/chat'
import { citationsToText } from '../../../shared/chatCitations'
import { CITE_HREF, citationClass, citeIndex, costText, notePaperOptions, withCitationLinks } from '../../lib/chat'
import { errorText } from '../../lib/errorText'

const ALLOWED_LINK = /^(https?:|mailto:)/i
/** Citation links and http(s)/mailto links; anything else (e.g. javascript:) is dropped. */
const urlTransform: UrlTransform = (url) => (url.startsWith(CITE_HREF) || ALLOWED_LINK.test(url) ? url : '')
const REMARK_PLUGINS = [remarkGfm]

/** An answer's Markdown with its citations as chips; without `citations` (still streaming) the chips are pending. */
export function AnswerMarkdown({
  text,
  citations,
  onOpenCitation
}: {
  text: string
  citations?: ChatCitation[]
  onOpenCitation?: (c: ChatCitation) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const index = citeIndex(href)
        if (index === null) {
          return href ? (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ) : (
            <>{children}</>
          )
        }
        const c = citations?.[index]
        // A citation of a paper in the trash or unknown only shows its state.
        const openable = Boolean(c && onOpenCitation && (c.state === 'found' || c.state === 'not_found'))
        return (
          <button
            type="button"
            className={citationClass(c)}
            title={c ? t('chat.quoted', { quote: c.quote }) : undefined}
            disabled={!openable}
            onClick={() => c && onOpenCitation?.(c)}
          >
            {children}
            {c && c.state !== 'found' && <span className="cite-state"> · {t(`chat.citation.${c.state}`)}</span>}
          </button>
        )
      }
    }),
    [citations, onOpenCitation, t]
  )
  return (
    <div className="chat-markdown">
      <Markdown remarkPlugins={REMARK_PLUGINS} urlTransform={urlTransform} components={components}>
        {withCitationLinks(text)}
      </Markdown>
    </div>
  )
}

export function ExcerptChip({ excerpt, onRemove }: { excerpt: ChatExcerpt; onRemove?: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <blockquote className="chat-excerpt">
      <span className="muted small">
        {excerpt.page === null ? t('chat.excerpt_no_page', { paper: excerpt.paper }) : t('chat.excerpt', { paper: excerpt.paper, page: excerpt.page })}
      </span>
      <span>{t('chat.quoted', { quote: excerpt.quote })}</span>
      {onRemove && (
        <button type="button" className="link small" onClick={onRemove}>
          {t('chat.remove_excerpt')}
        </button>
      )}
    </blockquote>
  )
}

export function UserMessageView({ message }: { message: UserMessage }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="chat-message user">
      <div className="chat-message-head muted small">{t('chat.you')}</div>
      {message.excerpt && <ExcerptChip excerpt={message.excerpt} />}
      <p className="chat-user-text">{message.text}</p>
    </div>
  )
}

interface AnswerViewProps {
  chatId: string
  index: number
  message: AssistantView
  /** The paper of a paper chat (null in the library chat): suggested first when the user picks where to save. */
  scopePaper: string | null
  /** A paper chat whose paper is in the library: «Guardar en notas del paper» saves there without asking. */
  savesToOwnPaper: boolean
  onOpenCitation: (c: ChatCitation) => void
}

type NoteOption = { id: string; title: string; suggested: boolean }

/** One answer with its chips, cost and the three actions; none writes without a click. */
export function AnswerView({ chatId, index, message, scopePaper, savesToOwnPaper, onOpenCitation }: AnswerViewProps): React.JSX.Element {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [options, setOptions] = useState<NoteOption[] | null>(null)
  const [target, setTarget] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const flash = (text: string): void => {
    setNotice(text)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setNotice(null), 2000)
  }
  const failed = (code: string): void => {
    setBusy(false)
    setError(errorText(t, code))
  }
  const copy = (): void => {
    setError(null)
    navigator.clipboard.writeText(citationsToText(message.text)).then(
      () => flash(t('chat.copied')),
      () => failed('unknown')
    )
  }
  const copyBibtex = (): void => {
    setBusy(true)
    setError(null)
    window.research.chats.bibtex(chatId, index).then(
      (r) => {
        if (!r.ok) return failed(r.error)
        return navigator.clipboard.writeText(r.text).then(
          () => {
            setBusy(false)
            flash(t('chat.copied_bibtex'))
          },
          () => failed('unknown')
        )
      },
      () => failed('unknown')
    )
  }
  /** `picked`: the paper the user chose; without it a paper chat saves to its own paper. */
  const save = (picked?: string): void => {
    setBusy(true)
    setError(null)
    window.research.chats.saveToNotes(chatId, index, picked).then(
      (r) => {
        if (!r.ok) return failed(r.error)
        setBusy(false)
        setOptions(null)
        flash(t('chat.saved_notes', { paper: picked ?? scopePaper ?? '' }))
      },
      () => failed('unknown')
    )
  }
  const startSave = (): void => {
    if (savesToOwnPaper) return save()
    setBusy(true)
    setError(null)
    window.research.library.list('').then(
      (rows) => {
        setBusy(false)
        const next = notePaperOptions(scopePaper, message.citations, rows)
        setOptions(next)
        setTarget(next[0]?.id ?? '')
      },
      () => failed('unknown')
    )
  }

  return (
    <div className="chat-message assistant">
      <div className="chat-message-head muted small">
        {t('chat.claude')} · {t('chat.answer_cost', { model: message.model, cost: costText(message.costUsd) })}
        {message.stopped && <> · {t('chat.stopped')}</>}
      </div>
      {message.text ? (
        <AnswerMarkdown text={message.text} citations={message.citations} onOpenCitation={onOpenCitation} />
      ) : (
        <p className="muted">{t('chat.stopped_empty')}</p>
      )}
      {message.unverified > 0 && <p className="small warning-text">{t('chat.unverified', { count: message.unverified })}</p>}
      <div className="row small chat-actions">
        <button className="small" disabled={!message.text} onClick={copy}>
          {t('chat.copy')}
        </button>
        <button className="small" disabled={busy || !message.text.trim()} onClick={startSave}>
          {t('chat.save_notes')}
        </button>
        <button
          className="small"
          disabled={busy || message.citations.length === 0}
          title={message.citations.length === 0 ? t('chat.no_citations') : undefined}
          onClick={copyBibtex}
        >
          {t('chat.copy_bibtex')}
        </button>
        {notice && <span className="muted">{notice}</span>}
      </div>
      {options && (
        <div className="row small chat-actions">
          <label>
            {t('chat.save_notes_pick')}{' '}
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.suggested ? t('chat.cited_option', { title: o.title }) : o.title}
                </option>
              ))}
            </select>
          </label>
          <button className="small primary" disabled={busy || !target} onClick={() => save(target)}>
            {t('chat.save_notes_confirm')}
          </button>
          <button className="small" onClick={() => setOptions(null)}>
            {t('chat.cancel')}
          </button>
        </div>
      )}
      {error && <div className="banner error">{error}</div>}
    </div>
  )
}
