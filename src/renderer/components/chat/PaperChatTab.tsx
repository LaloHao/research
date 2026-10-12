import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatExcerpt, ChatScope, ChatSummary } from '../../../shared/chat'
import { useEvent } from '../../hooks/useEvent'
import { useProjectModel } from '../../hooks/useProjectModel'
import { errorText } from '../../lib/errorText'
import { ChatList } from './ChatList'
import { Conversation } from './Conversation'

interface PaperChatTabProps {
  paperId: string
  /** The open conversation (null: a new one), kept by the paper's detail while the user switches tabs. */
  selected: string | null
  onSelectedChange: (id: string | null) => void
  /** The selection quoted in the next message («Preguntar a Claude»). */
  excerpt: ChatExcerpt | null
  onExcerptChange: (excerpt: ChatExcerpt | null) => void
}

/** The paper's «Chat» tab: its conversations and a new one; Claude can still search the whole library. */
export function PaperChatTab({ paperId, selected, onSelectedChange, excerpt, onExcerptChange }: PaperChatTabProps): React.JSX.Element {
  const { t } = useTranslation()
  const [list, setList] = useState<ChatSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const defaultModel = useProjectModel()
  const seq = useRef(0)
  const scope = useMemo<ChatScope>(() => ({ paper: paperId }), [paperId])

  const refresh = useCallback(() => {
    const token = ++seq.current
    window.research.chats.list({ paper: paperId }).then(
      (next) => {
        if (token !== seq.current) return
        setList(next)
        setError(null)
      },
      () => {
        if (token === seq.current) setError(errorText(t, 'unknown'))
      }
    )
  }, [paperId, t])
  useEffect(refresh, [refresh])
  useEvent('chats-changed', refresh)
  useEvent('project-changed', refresh)

  /** Bumped when the user opens another conversation or a new one; a conversation created by its first message keeps its instance. */
  const [session, setSession] = useState(0)
  // The excerpt stays across conversations: it was taken from this paper, for whichever conversation the user picks.
  const startNew = useCallback(() => {
    onSelectedChange(null)
    setSession((n) => n + 1)
  }, [onSelectedChange])
  const select = useCallback(
    (id: string) => {
      onSelectedChange(id)
      setSession((n) => n + 1)
    },
    [onSelectedChange]
  )

  return (
    <div className="paper-chat">
      <div className="chat-side">
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        <ChatList list={list} selected={selected} onSelect={select} onNew={startNew} />
      </div>
      {/* Keyed like the Chat view's: a new conversation stays mounted while its first message creates it. */}
      <Conversation
        key={session}
        chatId={selected}
        scope={scope}
        defaultModel={defaultModel}
        excerpt={excerpt}
        onExcerptChange={onExcerptChange}
        onCreated={onSelectedChange}
        onDeleted={startNew}
      />
    </div>
  )
}
