import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PaperRow } from '../../../shared/library'
import type { FacetFilter } from '../../../shared/relations'
import type { LlmModel } from '../../../shared/summary'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { filterByIds, filterByModel, filterBySummary, type SummaryFilter } from '../../lib/badges'
import { PaperDetail } from '../paper/PaperDetail'
import { ReviewView } from '../review/ReviewView'
import { AddPaperBar } from './AddPaperBar'
import { JobsPanel } from './JobsPanel'
import { PaperList } from './PaperList'
import { SummaryToolbar } from './SummaryToolbar'

export function LibraryView({
  facetFilters,
  onFacetFiltersChange,
  onVisibleChange,
  onOpenCandidates
}: {
  facetFilters: FacetFilter[]
  onFacetFiltersChange: (filters: FacetFilter[]) => void
  onVisibleChange?: (ids: string[]) => void
  onOpenCandidates: (paperId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<PaperRow[]>([])
  const [summaryFilter, setSummaryFilter] = useState<SummaryFilter>('all')
  const [modelFilter, setModelFilter] = useState<LlmModel | 'any'>('any')
  const [selected, setSelected] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [reviewIds, setReviewIds] = useState<string[] | null>(null)
  const [facetIds, setFacetIds] = useState<Set<string> | null>(null)
  const [citationsNotice, setCitationsNotice] = useState<{ error: boolean; text: string } | null>(null)
  const [updatingCitations, setUpdatingCitations] = useState(false)

  const facetIdsRequest = useRef(0)
  const loadFacetIds = useCallback(() => {
    const token = ++facetIdsRequest.current
    if (facetFilters.length === 0) {
      setFacetIds(null)
      return
    }
    window.research.map.facetPaperIds(facetFilters).then(
      (ids) => {
        if (token === facetIdsRequest.current) setFacetIds(new Set(ids))
      },
      () => {
        if (token === facetIdsRequest.current) setFacetIds(new Set())
      }
    )
  }, [facetFilters])
  useEffect(loadFacetIds, [loadFacetIds])
  useEvent('library-changed', loadFacetIds)

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

  const visibleRows = useMemo(
    () => filterByIds(filterByModel(filterBySummary(rows, summaryFilter), modelFilter), facetIds),
    [rows, summaryFilter, modelFilter, facetIds]
  )
  useEffect(() => onVisibleChange?.(visibleRows.map((row) => row.id)), [visibleRows, onVisibleChange])
  const anyFilter = query.trim() !== '' || summaryFilter !== 'all' || modelFilter !== 'any' || facetFilters.length > 0

  const updateCitations = (): void => {
    setUpdatingCitations(true)
    void window.research.citations.update(anyFilter ? visibleRows.map((row) => row.id) : undefined).then(
      (r) => {
        setUpdatingCitations(false)
        setCitationsNotice(r.ok ? { error: false, text: t('library.citations_queued', { count: r.count }) } : { error: true, text: errorText(t, r.error) })
      },
      () => {
        setUpdatingCitations(false)
        setCitationsNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

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
        <div className="row small pad">
          {facetFilters.map((f) => (
            <span key={`${f.facet}=${f.value}`} className="chip">
              {t('library.facet_filter', { facet: f.facet, value: f.value })}
              <button className="chip-remove" aria-label={t('library.remove_facet_filter')} onClick={() => onFacetFiltersChange(facetFilters.filter((x) => x !== f))}>
                ✕
              </button>
            </span>
          ))}
          <button
            className="small"
            disabled={updatingCitations}
            onClick={updateCitations}
            title={t(anyFilter ? 'library.update_citations_filtered' : 'library.update_citations_all')}
          >
            {t('library.update_citations')}
          </button>
        </div>
        {citationsNotice && <div className={`banner${citationsNotice.error ? ' error' : ''}`}>{citationsNotice.text}</div>}
        {reviewIds === null && <PaperList rows={visibleRows} query={query} selected={selected} onSelect={setSelected} />}
        <JobsPanel onSelectPaper={setSelected} />
      </aside>
      <section className="library-detail">
        {reviewIds !== null ? (
          <ReviewView ids={reviewIds} onExit={() => setReviewIds(null)} />
        ) : selected ? (
          <PaperDetail id={selected} onOpenCandidates={onOpenCandidates} onSelectPaper={setSelected} />
        ) : (
          <div className="center muted">{t('library.select_hint')}</div>
        )}
      </section>
      {dragging && <div className="drop-overlay">{t('library.drop_hint')}</div>}
    </div>
  )
}
