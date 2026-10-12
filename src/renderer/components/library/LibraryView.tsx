import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PaperRow } from '../../../shared/library'
import type { FacetFilter } from '../../../shared/relations'
import type { LlmModel, SummaryPlan } from '../../../shared/summary'
import type { RelationPlan } from '../../../shared/typedRelations'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { filterByIds, filterByModel, filterBySummary, type SummaryFilter } from '../../lib/badges'
import { PaperDetail } from '../paper/PaperDetail'
import { ReviewView } from '../review/ReviewView'
import { AddPaperBar } from './AddPaperBar'
import { JobsPanel } from './JobsPanel'
import { PaperList } from './PaperList'
import { SummaryToolbar } from './SummaryToolbar'
import { useTrashUndo } from '../TrashUndo'
import { batchConfirmHolds, batchRemoveReady, facetKey } from '../../lib/trash'

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
  // The search the rows were loaded for, and the facet filters facetIds were loaded for: the batch removal waits for both.
  const [rowsQuery, setRowsQuery] = useState<string | null>(null)
  const [summaryFilter, setSummaryFilter] = useState<SummaryFilter>('all')
  const [modelFilter, setModelFilter] = useState<LlmModel | 'any'>('any')
  const [selected, setSelected] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [reviewIds, setReviewIds] = useState<string[] | null>(null)
  const [facetIds, setFacetIds] = useState<{ ids: Set<string> | null; key: string }>({ ids: null, key: facetKey([]) })
  const [citationsNotice, setCitationsNotice] = useState<{ error: boolean; text: string } | null>(null)
  const [updatingCitations, setUpdatingCitations] = useState(false)
  const [relationsConfirm, setRelationsConfirm] = useState<{ ids: string[] | undefined; plan: RelationPlan } | null>(null)
  const [relationsBusy, setRelationsBusy] = useState(false)
  const [relationsNotice, setRelationsNotice] = useState<{ error: boolean; text: string } | null>(null)
  const [removeConfirm, setRemoveConfirm] = useState<string[] | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [removeNotice, setRemoveNotice] = useState<{ error: boolean; text: string } | null>(null)
  const [fillConfirm, setFillConfirm] = useState<{ ids: string[] | undefined; plan: SummaryPlan; visibleKey: string } | null>(null)
  const [fillBusy, setFillBusy] = useState(false)
  const [fillNotice, setFillNotice] = useState<{ error: boolean; text: string } | null>(null)
  // Bumped when the visible papers change: a plan asked for the previous list must not open a confirmation.
  const fillRequest = useRef(0)
  const undo = useTrashUndo()
  const showUndo = undo.show

  /** Papers just moved to the trash: the open one closes and «Deshacer» stays a few seconds. */
  const onRemoved = useCallback(
    (ids: string[]) => {
      setSelected((current) => (current && ids.includes(current) ? null : current))
      showUndo(ids)
    },
    [showUndo]
  )

  // The visible list a batch removal leaves: its error notice must survive the moved papers leaving the list.
  const keepNoticeFor = useRef<string | null>(null)
  const removeVisible = (): void => {
    if (!removeConfirm || removeBusy) return
    setRemoveBusy(true)
    const before = visibleRows.map((row) => row.id)
    window.research.library.trash(removeConfirm).then(
      (r) => {
        setRemoveBusy(false)
        setRemoveConfirm(null)
        keepNoticeFor.current = before.filter((id) => !r.moved.includes(id)).join(' ')
        if (r.moved.length > 0) onRemoved(r.moved)
        setRemoveNotice(r.error ? { error: true, text: errorText(t, r.error) } : null)
      },
      () => {
        setRemoveBusy(false)
        setRemoveNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  const facetIdsRequest = useRef(0)
  const loadFacetIds = useCallback(() => {
    const token = ++facetIdsRequest.current
    const key = facetKey(facetFilters)
    if (facetFilters.length === 0) {
      setFacetIds({ ids: null, key })
      return
    }
    window.research.map.facetPaperIds(facetFilters).then(
      (ids) => {
        if (token === facetIdsRequest.current) setFacetIds({ ids: new Set(ids), key })
      },
      () => {
        if (token === facetIdsRequest.current) setFacetIds({ ids: new Set(), key })
      }
    )
  }, [facetFilters])
  useEffect(loadFacetIds, [loadFacetIds])
  useEvent('library-changed', loadFacetIds)

  const rowsRequest = useRef(0)
  const refresh = useCallback(() => {
    const token = ++rowsRequest.current
    // Fails only when the project was just closed; this view is about to go away.
    window.research.library.list(query).then((next) => {
      if (token !== rowsRequest.current) return
      setRows(next)
      setRowsQuery(query)
    }, () => undefined)
  }, [query])
  useEffect(() => {
    const handle = setTimeout(refresh, 150)
    return () => clearTimeout(handle)
  }, [refresh])
  useEvent('library-changed', refresh)

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const paths = Array.from(e.dataTransfer.files)
      .filter((f) => f.name.toLowerCase().endsWith('.pdf'))
      .map((f) => window.research.pathForFile(f))
    if (paths.length) window.research.library.addPdfs(paths).catch((error: unknown) => console.error('add pdfs', error))
  }

  const visibleRows = useMemo(
    () => filterByIds(filterByModel(filterBySummary(rows, summaryFilter), modelFilter), facetIds.ids),
    [rows, summaryFilter, modelFilter, facetIds]
  )
  useEffect(() => onVisibleChange?.(visibleRows.map((row) => row.id)), [visibleRows, onVisibleChange])
  const anyFilter = query.trim() !== '' || summaryFilter !== 'all' || modelFilter !== 'any' || facetFilters.length > 0
  // A pending confirmation closes when the visible papers change (not when the list reloads the same), since its count would no longer hold.
  const visibleKey = useMemo(() => visibleRows.map((row) => row.id).join(' '), [visibleRows])
  useEffect(() => {
    setRemoveConfirm(null)
    setFillConfirm(null)
    fillRequest.current++
    // Old notices go when the visible papers change, except the list a batch removal just left.
    if (visibleKey !== keepNoticeFor.current) setRemoveNotice(null)
    keepNoticeFor.current = null
  }, [visibleKey])
  const removeReady = batchRemoveReady({ query, rowsQuery, facetFilters, facetIdsKey: facetIds.key })

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

  /** With a search or filter active, only the visible papers; otherwise every paper with candidates its last analysis did not see. */
  const planRelations = (): void => {
    if (relationsBusy) return
    const ids = anyFilter ? visibleRows.map((row) => row.id) : undefined
    setRelationsBusy(true)
    setRelationsNotice(null)
    setRelationsConfirm(null)
    window.research.relations.plan(ids).then(
      (plan) => {
        setRelationsBusy(false)
        if (plan.count === 0) setRelationsNotice({ error: false, text: t('library.relations_none') })
        else setRelationsConfirm({ ids, plan })
      },
      () => {
        setRelationsBusy(false)
        setRelationsNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  const runRelations = (): void => {
    if (!relationsConfirm || relationsBusy) return
    setRelationsBusy(true)
    window.research.relations.suggestBatch(relationsConfirm.ids).then(
      (r) => {
        setRelationsBusy(false)
        setRelationsConfirm(null)
        setRelationsNotice(r.ok ? { error: false, text: t('library.relations_queued', { count: r.count }) } : { error: true, text: errorText(t, r.error) })
      },
      () => {
        setRelationsBusy(false)
        setRelationsNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  /** «Llenar facetas nuevas»: with a search or filter active, only the visible papers; otherwise every paper that needs it. */
  const planFill = (): void => {
    if (fillBusy || !removeReady) return
    const ids = anyFilter ? visibleRows.map((row) => row.id) : undefined
    const token = ++fillRequest.current
    const plannedFor = visibleKey
    setFillBusy(true)
    setFillNotice(null)
    setFillConfirm(null)
    window.research.facets.fillPlan(ids).then(
      (plan) => {
        setFillBusy(false)
        if (token !== fillRequest.current) return
        if (plan.count === 0) setFillNotice({ error: false, text: t('library.fill_none') })
        else setFillConfirm({ ids, plan, visibleKey: plannedFor })
      },
      () => {
        setFillBusy(false)
        if (token !== fillRequest.current) return
        setFillNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  const runFill = (): void => {
    if (!fillConfirm || fillBusy) return
    if (!batchConfirmHolds(fillConfirm, { visibleKey, ready: removeReady })) {
      setFillConfirm(null)
      return
    }
    setFillBusy(true)
    window.research.facets.fill(fillConfirm.ids).then(
      (r) => {
        setFillBusy(false)
        setFillConfirm(null)
        setFillNotice(r.ok ? { error: false, text: t('facets.fill_queued', { count: r.count }) } : { error: true, text: errorText(t, r.error) })
      },
      () => {
        setFillBusy(false)
        setFillNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  return (
    <div
      className={`library${dragging ? ' dragging' : ''}`}
      // A paper's own drop zone (its PDF or Contenido tab) takes the file instead, and stops the drop reaching the library.
      onDragOverCapture={(e) => setDragging(!(e.target instanceof Element && e.target.closest('[data-pdf-drop]')))}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDropCapture={() => setDragging(false)}
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
          <button
            className="small"
            disabled={relationsBusy}
            onClick={planRelations}
            title={t(anyFilter ? 'library.suggest_relations_filtered' : 'library.suggest_relations_all')}
          >
            {t('library.suggest_relations')}
          </button>
          {/* With a filter, the visible rows must be the ones loaded for the current search and facet filters. */}
          <button
            className="small"
            disabled={fillBusy || !removeReady}
            onClick={planFill}
            title={t(anyFilter ? 'library.fill_facets_filtered' : 'library.fill_facets_all')}
          >
            {t('library.fill_facets')}
          </button>
          {anyFilter && removeReady && visibleRows.length > 0 && (
            <button
              className="small"
              disabled={removeBusy}
              onClick={() => {
                setRemoveNotice(null)
                setRemoveConfirm(visibleRows.map((row) => row.id))
              }}
              title={t('library.remove_filtered_hint')}
            >
              {t('library.remove_filtered')}
            </button>
          )}
        </div>
        {citationsNotice && <div className={`banner${citationsNotice.error ? ' error' : ''}`}>{citationsNotice.text}</div>}
        {relationsConfirm && (
          <div className="banner">
            <span>
              {t('library.batch_confirm', {
                count: relationsConfirm.plan.count,
                cost: relationsConfirm.plan.estimateUsd.toFixed(2),
                limit: relationsConfirm.plan.batchLimitUsd.toFixed(2)
              })}
            </span>
            <button className="primary" disabled={relationsBusy} onClick={runRelations}>
              {t('library.confirm')}
            </button>
            <button onClick={() => setRelationsConfirm(null)}>{t('jobs.cancel')}</button>
          </div>
        )}
        {relationsNotice && <div className={`banner${relationsNotice.error ? ' error' : ''}`}>{relationsNotice.text}</div>}
        {fillConfirm && (
          <div className="banner">
            <span>
              {t('facets.fill_confirm', {
                count: fillConfirm.plan.count,
                cost: fillConfirm.plan.estimateUsd.toFixed(2),
                limit: fillConfirm.plan.batchLimitUsd.toFixed(2)
              })}
            </span>
            <button className="primary" disabled={fillBusy} autoFocus onClick={runFill}>
              {t('library.confirm')}
            </button>
            <button disabled={fillBusy} onClick={() => setFillConfirm(null)}>
              {t('jobs.cancel')}
            </button>
          </div>
        )}
        {fillNotice && <div className={`banner${fillNotice.error ? ' error' : ''}`}>{fillNotice.text}</div>}
        {removeConfirm && (
          <div className="banner warning">
            <span>{t('library.remove_confirm', { count: removeConfirm.length })}</span>
            <button className="danger" disabled={removeBusy} onClick={removeVisible}>
              {t('library.remove_filtered')}
            </button>
            <button disabled={removeBusy} onClick={() => setRemoveConfirm(null)}>
              {t('jobs.cancel')}
            </button>
          </div>
        )}
        {removeNotice && <div className={`banner${removeNotice.error ? ' error' : ''}`}>{removeNotice.text}</div>}
        {reviewIds === null && <PaperList rows={visibleRows} query={query} selected={selected} onSelect={setSelected} />}
        <JobsPanel onSelectPaper={setSelected} />
      </aside>
      <section className="library-detail">
        {reviewIds !== null ? (
          <ReviewView ids={reviewIds} onExit={() => setReviewIds(null)} />
        ) : selected ? (
          <PaperDetail id={selected} onOpenCandidates={onOpenCandidates} onSelectPaper={setSelected} onRemoved={onRemoved} />
        ) : (
          <div className="center muted">{t('library.select_hint')}</div>
        )}
      </section>
      {dragging && <div className="drop-overlay">{t('library.drop_hint')}</div>}
      {undo.element}
    </div>
  )
}
