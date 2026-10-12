import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActionResult } from '../../../shared/ipc'
import type { PaperDetail } from '../../../shared/library'
import type { ChatCitation, ChatConversation, ChatExcerpt, ChatScope, ChatStreamUpdate } from '../../../shared/chat'
import { LLM_MODELS, type LlmModel } from '../../../shared/summary'
import { useChatStream } from '../../hooks/useChatStream'
import { useEvent } from '../../hooks/useEvent'
import {
  applyUpdate,
  chatTitle,
  composerAction,
  costText,
  hidePartialMarker,
  isNearBottom,
  liveFromPartial,
  streamAction,
  takeBuffered,
  type LiveAnswer
} from '../../lib/chat'
import { errorText } from '../../lib/errorText'
import { EvidencePanel, type Picked } from '../review/EvidencePanel'
import { AnswerMarkdown, AnswerView, ExcerptChip, UserMessageView } from './ChatMessage'

interface ConversationProps {
  /** null: a new conversation, created by its first message. */
  chatId: string | null
  /** The scope of a new conversation (an existing one keeps its own). */
  scope: ChatScope
  /** The project's model, for a new conversation. */
  defaultModel: LlmModel
  /** The selection quoted in the next message («Preguntar a Claude»). */
  excerpt: ChatExcerpt | null
  onExcerptChange: (excerpt: ChatExcerpt | null) => void
  onCreated: (id: string) => void
  onDeleted: () => void
}

/** `retrySend`: a refused send; «Reintentar» sends what the composer holds now. */
type ErrorState = { text: string; retrySend?: boolean }

export function Conversation({ chatId, scope, defaultModel, excerpt, onExcerptChange, onCreated, onDeleted }: ConversationProps): React.JSX.Element {
  const { t } = useTranslation()
  const [chat, setChat] = useState<ChatConversation | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [live, setLive] = useState<LiveAnswer | null>(null)
  const [draft, setDraft] = useState('')
  const [model, setModel] = useState<LlmModel>(defaultModel)
  const [pending, setPending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<ErrorState | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [evidence, setEvidence] = useState<{ detail: PaperDetail; picked: Picked } | null>(null)
  const loadSeq = useRef(0)
  const evidenceSeq = useRef(0)
  /** The newest stream sequence number this conversation has seen (updates and `open()` snapshots). */
  const seenSeq = useRef(-1)
  /** An answer is shown as running (set synchronously, so updates arriving in one burst agree on it). */
  const runningRef = useRef(false)
  /** A snapshot was asked for because an update arrived mid-answer with nothing to apply it to. */
  const resyncing = useRef(false)
  /** A new conversation's first message is being sent; its updates wait in `buffered` until its id is known. */
  const awaitingNew = useRef(false)
  const buffered = useRef<ChatStreamUpdate[]>([])
  /** The user picked a model for the new conversation: the project's model no longer replaces it. */
  const modelTouched = useRef(false)
  /** The reader is at the bottom of the messages: new text keeps them there. */
  const stick = useRef(true)
  const messagesRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  /** The id of the conversation this component's first message just created, until the prop catches up. */
  const createdId = useRef<string | null>(null)
  if (chatId !== null) createdId.current = null
  const idRef = useRef(chatId)
  idRef.current = chatId ?? createdId.current

  const load = useCallback(() => {
    const token = ++loadSeq.current
    const chatId = idRef.current
    if (!chatId) {
      resyncing.current = false
      setChat(null)
      setLoadError(null)
      return
    }
    window.research.chats.open(chatId).then(
      (r) => {
        if (token !== loadSeq.current) return
        resyncing.current = false
        if (!r.ok) return setLoadError(errorText(t, r.error))
        setLoadError(null)
        setChat(r.chat)
        setModel(r.chat.summary.model)
        const partial = r.chat.partial
        if (partial) {
          seenSeq.current = Math.max(seenSeq.current, partial.seq)
          runningRef.current = true
        }
        setLive((current) => {
          if (partial) return liveFromPartial(partial, current)
          // Nothing running in the snapshot: a started answer whose first update beat the snapshot stays, a failure
          // keeps its «Reintentar», anything finished is now among the messages.
          return current?.status === 'running' || current?.status === 'error' ? current : null
        })
      },
      () => {
        if (token !== loadSeq.current) return
        resyncing.current = false
        setLoadError(errorText(t, 'unknown'))
      }
    )
  }, [t])
  useEffect(load, [chatId, load])
  useEvent('chats-changed', load)
  // Another project (or its settings): whatever was streaming belongs to the old state.
  useEvent('project-changed', () => {
    runningRef.current = false
    setStopping(false)
    setLive(null)
    load()
  })
  useEffect(() => {
    if (!chatId && !modelTouched.current) setModel(defaultModel)
  }, [chatId, defaultModel])
  const handleUpdate = (u: ChatStreamUpdate): void => {
    const action = streamAction({ chatId: idRef.current, awaitingNew: awaitingNew.current, seenSeq: seenSeq.current, running: runningRef.current }, u)
    if (action === 'ignore') return
    if (action === 'buffer') {
      buffered.current.push(u)
      return
    }
    if (action === 'resync') {
      if (!resyncing.current) {
        resyncing.current = true
        load()
      }
      return
    }
    seenSeq.current = u.seq
    if (u.kind === 'start') runningRef.current = true
    setLive((current) => applyUpdate(current, u))
    if (u.kind === 'done' || u.kind === 'stopped' || u.kind === 'error') {
      runningRef.current = false
      setStopping(false)
      load()
    }
  }
  useChatStream(handleUpdate)
  // A quoted selection arrived («Preguntar a Claude»): the question about it is typed next.
  useEffect(() => {
    if (excerpt) composerRef.current?.focus()
  }, [excerpt])
  useEffect(() => {
    const el = messagesRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [chat?.messages.length, live?.text, live?.status])

  const running = live?.status === 'running'
  const summary = chat?.summary ?? null
  const fail = (text: string, retrySend?: boolean): void => {
    setPending(false)
    setError({ text, retrySend })
  }

  /** A header action: one request at a time; the list and the conversation reload on chats-changed. */
  const act = (action: () => Promise<ActionResult>, after?: () => void, undo?: () => void): void => {
    setPending(true)
    setError(null)
    action().then(
      (r) => {
        setPending(false)
        if (!r.ok) {
          undo?.()
          return setError({ text: errorText(t, r.error) })
        }
        after?.()
      },
      () => {
        undo?.()
        fail(errorText(t, 'unknown'))
      }
    )
  }

  const send = (): void => {
    const text = draft.trim()
    if (!text || pending || running) return
    setPending(true)
    setError(null)
    // A failed answer's banner goes; the new answer's updates replace it.
    setLive((current) => (current?.status === 'running' ? current : null))
    stick.current = true
    const creating = chatId === null
    if (creating) {
      awaitingNew.current = true
      buffered.current = []
    }
    const settleNew = (): ChatStreamUpdate[] => {
      const pendingUpdates = buffered.current
      awaitingNew.current = false
      buffered.current = []
      return pendingUpdates
    }
    window.research.chats.send({ chatId, scope: summary?.scope ?? scope, model, text, excerpt }).then(
      (r) => {
        const pendingUpdates = creating ? settleNew() : []
        if (!r.ok) return fail(errorText(t, r.error), true)
        setPending(false)
        setDraft('')
        onExcerptChange(null)
        if (creating) {
          // The same component goes on showing the new conversation: its first answer's updates (a quick failure
          // included) are applied here rather than lost to a remount.
          createdId.current = r.chatId
          idRef.current = r.chatId
          takeBuffered(pendingUpdates, r.chatId).forEach(handleUpdate)
          onCreated(r.chatId)
        } else load()
      },
      () => {
        if (creating) settleNew()
        fail(errorText(t, 'unknown'), true)
      }
    )
  }

  const retry = (): void => {
    if (!chatId || pending) return
    setLive(null)
    act(() => window.research.chats.retry(chatId), load)
  }

  const stop = (): void => {
    if (!chatId) return
    setStopping(true)
    window.research.chats.stop(chatId).then(
      () => undefined,
      () => {
        setStopping(false)
        setError({ text: errorText(t, 'unknown') })
      }
    )
  }

  const changeModel = (next: LlmModel): void => {
    const previous = model
    modelTouched.current = true
    setModel(next)
    if (chatId) act(() => window.research.chats.setModel(chatId, next), undefined, () => setModel(previous))
  }

  const openCitation = useCallback(
    (c: ChatCitation) => {
      const token = ++evidenceSeq.current
      window.research.library.detail(c.paper).then(
        (detail) => {
          if (token === evidenceSeq.current) setEvidence({ detail, picked: { page: c.page, quote: c.quote } })
        },
        () => {
          if (token === evidenceSeq.current) setError({ text: errorText(t, 'unknown') })
        }
      )
    },
    [t]
  )

  const scopePaper = summary && summary.scope !== 'library' ? summary.scope.paper : null
  const savesToOwnPaper = scopePaper !== null && summary?.paperState === 'library'
  const showRetry = live?.status === 'error' || (!live && chat?.canRetry)

  return (
    <div className="conversation-wrap">
      <section className="conversation">
        <header className="chat-header">
          {renaming !== null && summary ? (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault()
                if (pending || !renaming.trim()) return
                act(() => window.research.chats.rename(summary.id, renaming), () => setRenaming(null))
              }}
            >
              <input value={renaming} maxLength={120} aria-label={t('chat.rename')} onChange={(e) => setRenaming(e.target.value)} />
              <button className="small primary" type="submit" disabled={pending || !renaming.trim()}>
                {t('chat.rename_save')}
              </button>
              <button className="small" type="button" onClick={() => setRenaming(null)}>
                {t('chat.cancel')}
              </button>
            </form>
          ) : (
            <h3>{summary ? chatTitle(t, summary) : t('chat.new')}</h3>
          )}
          {summary && scopePaper && <p className="muted small">{t('chat.about_paper', { title: summary.paperTitle ?? scopePaper })}</p>}
          <div className="row small">
            <label>
              {t('chat.model')}{' '}
              <select value={model} disabled={pending || running} onChange={(e) => changeModel(e.target.value as LlmModel)}>
                {LLM_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {t(`settings.models.${m}`)}
                  </option>
                ))}
              </select>
            </label>
            {summary && (
              <>
                <span className="muted">{t('chat.total_cost', { cost: costText(summary.costUsd) })}</span>
                {renaming === null && (
                  <button className="small" disabled={pending} onClick={() => setRenaming(summary.title)}>
                    {t('chat.rename')}
                  </button>
                )}
                <button className="small" disabled={pending} onClick={() => act(() => window.research.chats.archive(summary.id, !summary.archived))}>
                  {t(summary.archived ? 'chat.unarchive' : 'chat.archive')}
                </button>
                <button className="small" disabled={pending || running} onClick={() => setConfirmDelete(true)}>
                  {t('chat.delete')}
                </button>
              </>
            )}
          </div>
          {confirmDelete && summary && (
            <div className="banner warning" role="alertdialog" aria-label={t('chat.delete')}>
              <span>{t('chat.delete_confirm', { title: chatTitle(t, summary) })}</span>
              {/* The only call that passes `confirmed`: the user answered the question above. */}
              <button className="small" disabled={pending || running} onClick={() => act(() => window.research.chats.remove(summary.id, true), onDeleted)}>
                {t('chat.delete_yes')}
              </button>
              {/* Focus lands on the safe choice: Enter on a freshly shown question never deletes. */}
              <button className="small" autoFocus onClick={() => setConfirmDelete(false)}>
                {t('chat.cancel')}
              </button>
            </div>
          )}
          {summary?.paperState === 'trash' && <div className="banner warning">{t('chat.paper_in_trash_banner')}</div>}
          {summary?.paperState === 'missing' && <div className="banner warning">{t('chat.paper_missing_banner')}</div>}
        </header>
        <div
          className="chat-messages"
          ref={messagesRef}
          onScroll={(e) => {
            stick.current = isNearBottom(e.currentTarget)
          }}
        >
          {loadError && (
            <div className="banner error" role="alert">
              {loadError}
            </div>
          )}
          {!chatId && !live && <p className="muted">{t(scope === 'library' ? 'chat.intro_library' : 'chat.intro_paper')}</p>}
          {chat?.messages.map((m, i) =>
            m.role === 'user' ? (
              <UserMessageView key={i} message={m} />
            ) : (
              <AnswerView
                key={i}
                chatId={chat.summary.id}
                index={i}
                message={m}
                scopePaper={scopePaper}
                scopePaperTitle={summary?.paperTitle ?? null}
                savesToOwnPaper={savesToOwnPaper}
                onOpenCitation={openCitation}
              />
            )
          )}
          {running && (
            <div className="chat-message assistant live">
              <div className="chat-message-head muted small" role="status">
                {t('chat.thinking')}
                {live.tools > 0 && <> · {t('chat.tools', { count: live.tools })}</>}
              </div>
              {live.text && <AnswerMarkdown text={hidePartialMarker(live.text)} />}
            </div>
          )}
          {showRetry && (
            <div className="banner error" role="alert">
              <span>{live?.error ? errorText(t, live.error) : t('chat.unanswered')}</span>
              <button className="small" disabled={pending} onClick={retry}>
                {t('chat.retry')}
              </button>
            </div>
          )}
          {error && (
            <div className="banner error" role="alert">
              <span>{error.text}</span>
              {error.retrySend && (
                <button className="small" disabled={pending || running || !draft.trim()} onClick={send}>
                  {t('chat.retry')}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="chat-composer">
          {excerpt && <ExcerptChip excerpt={excerpt} onRemove={() => onExcerptChange(null)} />}
          <textarea
            ref={composerRef}
            value={draft}
            rows={3}
            placeholder={t('chat.placeholder')}
            aria-label={t('chat.placeholder')}
            disabled={running || pending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (composerAction({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }) === 'send') {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="row">
            {running ? (
              <button disabled={stopping} onClick={stop}>
                {t('chat.stop')}
              </button>
            ) : (
              <button className="primary" disabled={pending || !draft.trim()} onClick={send}>
                {t('chat.send')}
              </button>
            )}
          </div>
        </div>
      </section>
      {evidence && (
        <aside className="chat-evidence">
          <div className="row chat-evidence-head">
            <strong>{evidence.detail.paper?.title ?? evidence.detail.id}</strong>
            <button className="small" onClick={() => setEvidence(null)}>
              {t('chat.close_evidence')}
            </button>
          </div>
          <EvidencePanel detail={evidence.detail} evidence={evidence.picked} />
        </aside>
      )}
    </div>
  )
}
