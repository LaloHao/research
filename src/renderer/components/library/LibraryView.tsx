import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PaperRow } from '../../../shared/library'
import type { LlmModel } from '../../../shared/summary'
import { useEvent } from '../../hooks/useEvent'
import { filterByModel, filterBySummary, type SummaryFilter } from '../../lib/badges'
import { PaperDetail } from '../paper/PaperDetail'
import { ReviewView } from '../review/ReviewView'
import { AddPaperBar } from './AddPaperBar'
import { JobsPanel } from './JobsPanel'
import { PaperList } from './PaperList'
import { SummaryToolbar } from './SummaryToolbar'

export function LibraryView({ onVisibleChange }: { onVisibleChange?: (ids: string[]) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<PaperRow[]>([])
  const [summaryFilter, setSummaryFilter] = useState<SummaryFilter>('all')
  const [modelFilter, setModelFilter] = useState<LlmModel | 'any'>('any')
  const [selected, setSelected] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [reviewIds, setReviewIds] = useState<string[] | null>(null)

  const refresh = useCallback(() => {
    // Fails only when the project was just closed; this view is about to go away.
    window.research.library.list(query).then(setRows, () => undefined)
  }, [query])
  useEffect(() => {
    const handle = setTimeout(refresh, 150)
    return () => clearTimeout(handle)
  }, [refresh])
  useEvent('library-changed', refresh)

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    const paths = Array.from(e.dataTransfer.files)
      .filter((f) => f.name.toLowerCase().endsWith('.pdf'))
      .map((f) => window.research.pathForFile(f))
    if (paths.length) window.research.library.addPdfs(paths).catch((error: unknown) => console.error('add pdfs', error))
  }

  const visibleRows = useMemo(() => filterByModel(filterBySummary(rows, summaryFilter), modelFilter), [rows, summaryFilter, modelFilter])
  useEffect(() => onVisibleChange?.(visibleRows.map((row) => row.id)), [visibleRows, onVisibleChange])

  return (
    <div
      className={`library${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <aside className="library-list">
        <input className="search" type="search" value={query} placeholder={t('library.search_placeholder')} onChange={(e) => setQuery(e.target.value)} />
        <AddPaperBar />
        <SummaryToolbar
          filter={summaryFilter}
          onFilterChange={setSummaryFilter}
          model={modelFilter}
          onModelChange={setModelFilter}
          visibleRows={visibleRows}
          onReview={() => setReviewIds(visibleRows.map((row) => row.id))}
        />
        {reviewIds === null && <PaperList rows={visibleRows} query={query} selected={selected} onSelect={setSelected} />}
        <JobsPanel onSelectPaper={setSelected} />
      </aside>
      <section className="library-detail">
        {reviewIds !== null ? (
          <ReviewView ids={reviewIds} onExit={() => setReviewIds(null)} />
        ) : selected ? (
          <PaperDetail id={selected} />
        ) : (
          <div className="center muted">{t('library.select_hint')}</div>
        )}
      </section>
      {dragging && <div className="drop-overlay">{t('library.drop_hint')}</div>}
    </div>
  )
}
