import { useTranslation } from 'react-i18next'
import type { ChatSummary } from '../../../shared/chat'
import { chatTitle, costText, splitArchived, writingPlace } from '../../lib/chat'

interface ChatListProps {
  list: ChatSummary[]
  selected: string | null
  onSelect: (id: string) => void
  onNew: () => void
  /** Search and paper filter; the paper's Chat tab shows neither. */
  query?: string
  onQueryChange?: (query: string) => void
  paper?: string
  papers?: { id: string; title: string }[]
  onPaperChange?: (paper: string) => void
  /** Nothing matches the search or filter (as opposed to no conversations at all). */
  filtered?: boolean
}

export function ChatList({ list, selected, onSelect, onNew, query, onQueryChange, paper, papers, onPaperChange, filtered }: ChatListProps): React.JSX.Element {
  const { t } = useTranslation()
  const { active, archived } = splitArchived(list)
  const item = (c: ChatSummary): React.JSX.Element => (
    <li key={c.id}>
      <button className={`chat-list-item${c.id === selected ? ' active' : ''}`} aria-current={c.id === selected || undefined} onClick={() => onSelect(c.id)}>
        <span>{chatTitle(t, c)}</span>
        <span className="muted small">
          {c.problem
            ? t('chat.problem')
            : [
                c.writing ? writingPlace(t, c.writing) : c.scope === 'library' ? t('chat.library_scope') : (c.paperTitle ?? c.scope.paper),
                c.updatedAt.slice(0, 10),
                costText(c.costUsd)
              ].join(' · ')}
        </span>
      </button>
    </li>
  )
  return (
    <nav className="chat-list">
      <button className="primary" onClick={onNew}>
        {t('chat.new')}
      </button>
      {onQueryChange && (
        <input
          type="search"
          value={query ?? ''}
          placeholder={t('chat.search_placeholder')}
          aria-label={t('chat.search_placeholder')}
          onChange={(e) => onQueryChange(e.target.value)}
        />
      )}
      {onPaperChange && papers && papers.length > 0 && (
        <select value={paper ?? ''} aria-label={t('chat.paper_filter_all')} onChange={(e) => onPaperChange(e.target.value)}>
          <option value="">{t('chat.paper_filter_all')}</option>
          {papers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      )}
      {list.length === 0 && <p className="muted small">{t(filtered ? 'chat.no_results' : 'chat.empty')}</p>}
      <ul className="plain-list">{active.map(item)}</ul>
      {archived.length > 0 && (
        <details>
          <summary className="muted small">{t('chat.archived', { count: archived.length })}</summary>
          <ul className="plain-list">{archived.map(item)}</ul>
        </details>
      )}
    </nav>
  )
}
