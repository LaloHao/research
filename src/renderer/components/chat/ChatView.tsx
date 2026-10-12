import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatExcerpt, ChatSummary } from '../../../shared/chat'
import { useEvent } from '../../hooks/useEvent'
import { useProjectModel } from '../../hooks/useProjectModel'
import { paperFilterOptions } from '../../lib/chat'
import { errorText } from '../../lib/errorText'
import { ChatList } from './ChatList'
import { Conversation } from './Conversation'

/** The rail's Chat view: every conversation (library and paper chats), and the open one. */
export function ChatView(): React.JSX.Element {
  const { t } = useTranslation()
  const [list, setList] = useState<ChatSummary[]>([])
  const [all, setAll] = useState<ChatSummary[]>([])
  const [query, setQuery] = useState('')
  const [paper, setPaper] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [excerpt, setExcerpt] = useState<ChatExcerpt | null>(null)
  const defaultModel = useProjectModel()
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const refresh = useCallback(() => {
    const token = ++seq.current
    Promise.all([window.research.chats.list({ text: query.trim() || undefined, paper: paper || undefined }), window.research.chats.list()]).then(
      ([filtered, everything]) => {
        if (token !== seq.current) return
        setList(filtered)
        setAll(everything)
        setError(null)
      },
      () => {
        if (token === seq.current) setError(errorText(t, 'unknown'))
      }
    )
  }, [query, paper, t])
  useEffect(refresh, [refresh])
  useEvent('chats-changed', refresh)
  useEvent('project-changed', refresh)

  const startNew = useCallback(() => {
    setSelected(null)
    setExcerpt(null)
  }, [])
  const papers = useMemo(() => paperFilterOptions(all), [all])

  return (
    <div className="chat-view">
      <div className="chat-side">
        {error && <div className="banner error">{error}</div>}
        <ChatList
          list={list}
          selected={selected}
          onSelect={setSelected}
          onNew={startNew}
          query={query}
          onQueryChange={setQuery}
          paper={paper}
          papers={papers}
          onPaperChange={setPaper}
          filtered={Boolean(query.trim() || paper) && all.length > 0}
        />
      </div>
      {/* Keyed by the conversation: its draft, live answer and side panel never leak into another one. */}
      <Conversation
        key={selected ?? 'new'}
        chatId={selected}
        scope="library"
        defaultModel={defaultModel}
        excerpt={excerpt}
        onExcerptChange={setExcerpt}
        onCreated={setSelected}
        onDeleted={startNew}
      />
    </div>
  )
}
