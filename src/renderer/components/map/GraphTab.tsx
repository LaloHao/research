import cytoscape, { type Core, type ElementDefinition } from 'cytoscape'
import fcose from 'cytoscape-fcose'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FacetOption, GraphData, ModelInfo, SimilarityReason } from '../../../shared/relations'
import { useDebouncedCallback } from '../../hooks/useDebouncedCallback'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { buildElements, lensColors, NO_VALUE, OTHER_VALUES, type Lens } from '../../lib/graphElements'
import { reasonsText } from '../../lib/reasons'
import { PaperDetail } from '../paper/PaperDetail'

cytoscape.use(fcose)

const cssVar = (name: string, fallback: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

/** Cytoscape cannot read CSS variables: the theme colors are copied when the graph is created. */
function graphStyle(): cytoscape.CytoscapeOptions['style'] {
  const text = cssVar('--muted', '#666666')
  const edge = cssVar('--border', '#bbbbbb')
  return [
    {
      selector: 'node',
      style: {
        'background-color': 'data(color)',
        width: 'data(size)',
        height: 'data(size)',
        label: 'data(label)',
        'font-size': 9,
        color: text,
        'text-valign': 'bottom',
        'text-margin-y': 3
      }
    },
    { selector: 'node:selected', style: { 'border-width': 3, 'border-color': cssVar('--accent', '#2563eb') } },
    { selector: 'edge.citation', style: { 'line-color': edge, 'target-arrow-color': edge, 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', width: 1.2 } },
    { selector: 'edge.similarity', style: { 'line-color': '#7aa6d8', 'line-style': 'dashed', 'curve-style': 'bezier', width: 'mapData(score, 0, 1, 0.5, 4)' } }
  ] as unknown as cytoscape.CytoscapeOptions['style']
}

export function GraphTab({ visibleIds }: { visibleIds: string[] | null }): React.JSX.Element {
  const { t } = useTranslation()
  const [data, setData] = useState<GraphData | null>(null)
  const [facets, setFacets] = useState<FacetOption[]>([])
  const [lensKind, setLensKind] = useState<'area' | 'thesis'>('area')
  const [facet, setFacet] = useState<string | null>(null)
  const [showCitations, setShowCitations] = useState(true)
  const [showSimilarity, setShowSimilarity] = useState(true)
  const [threshold, setThreshold] = useState(0.3)
  const [useLibraryFilters, setUseLibraryFilters] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [hover, setHover] = useState<SimilarityReason[] | null>(null)
  const [model, setModel] = useState<ModelInfo | null>(null)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const cy = useRef<Core | null>(null)
  /** Sorted node ids of the last layout: the layout only runs again when the set of papers changes. */
  const layoutKey = useRef<string | null>(null)

  const refreshModel = useCallback(() => {
    window.research.models.info().then(setModel, () => undefined)
  }, [])
  const refresh = useCallback(() => {
    window.research.map.graph().then(setData, () => undefined)
    window.research.map.facets().then(
      (options) => {
        setFacets(options)
        setFacet((current) => (current && options.some((o) => o.key === current) ? current : (options[0]?.key ?? null)))
      },
      () => undefined
    )
    refreshModel()
  }, [refreshModel])
  useEffect(refresh, [refresh])
  const refreshSoon = useDebouncedCallback(refresh, 500)
  useEvent('library-changed', refreshSoon)
  useEvent('project-changed', refreshSoon)
  useEvent('jobs-changed', useDebouncedCallback(refreshModel, 500))

  const lens: Lens = useMemo(() => (lensKind === 'thesis' ? { kind: 'thesis' } : { kind: 'area', facet }), [lensKind, facet])
  const legend = useMemo(() => (data ? lensColors(data.nodes, lens).legend : []), [data, lens])
  const visible = useMemo(() => (useLibraryFilters && visibleIds ? new Set(visibleIds) : null), [useLibraryFilters, visibleIds])
  const elements = useMemo(
    () => (data ? buildElements(data, { lens, showCitations, showSimilarity, threshold, visibleIds: visible }) : []),
    [data, lens, showCitations, showSimilarity, threshold, visible]
  )

  // One cytoscape instance per mount; React never renders inside its container.
  useEffect(() => {
    if (!container.current) return
    const instance = cytoscape({ container: container.current, style: graphStyle(), wheelSensitivity: 0.3, minZoom: 0.1, maxZoom: 4 })
    instance.on('tap', 'node', (event) => setSelected(event.target.id() as string))
    instance.on('mouseover', 'edge.similarity', (event) => setHover(event.target.data('reasons') as SimilarityReason[]))
    instance.on('mouseout', 'edge', () => setHover(null))
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(container.current)
    cy.current = instance
    return () => {
      observer.disconnect()
      instance.destroy()
      cy.current = null
      layoutKey.current = null
    }
  }, [])

  // Updates in place: unchanged nodes keep their positions; edge toggles, threshold and lens never move anything.
  useEffect(() => {
    const instance = cy.current
    if (!instance) return
    const wanted = new Set(elements.map((e) => String(e.data.id)))
    instance.batch(() => {
      instance.elements().filter((el) => !wanted.has(el.id())).remove()
      // Nodes come before edges in `elements`, so an edge's endpoints always exist when it is added.
      for (const def of elements) {
        const existing = instance.getElementById(String(def.data.id))
        if (existing.nonempty()) existing.data(def.data)
        else instance.add(def as ElementDefinition)
      }
    })
    const key = elements
      .filter((e) => e.group === 'nodes')
      .map((e) => String(e.data.id))
      .sort()
      .join('|')
    if (key === layoutKey.current) return
    const first = layoutKey.current === null
    layoutKey.current = key
    instance.layout({ name: 'fcose', animate: false, randomize: first } as unknown as cytoscape.LayoutOptions).run()
  }, [elements])

  const exportPng = async (): Promise<void> => {
    const instance = cy.current
    if (!instance) return
    const blob = instance.png({ output: 'blob', full: true, scale: 2, bg: cssVar('--bg', '#ffffff') })
    const result = await window.research.exports.save('graph.png', new Uint8Array(await blob.arrayBuffer()))
    if (result.ok) setNotice({ error: false, text: t('map.graph.exported', { path: result.path }) })
    else if (result.error) setNotice({ error: true, text: errorText(t, result.error) })
  }

  const legendLabel = (label: string): string => {
    if (label === OTHER_VALUES) return t('map.graph.other_values')
    if (label === NO_VALUE) return t(lensKind === 'thesis' ? 'map.graph.no_relation' : 'map.graph.no_value')
    return lensKind === 'thesis' ? t('map.graph.score', { score: label }) : label
  }

  return (
    <div className="map-graph">
      <div className="graph-main">
        <div className="row small graph-controls">
          <label>
            {t('map.graph.lens')}{' '}
            <select value={lensKind} onChange={(e) => setLensKind(e.target.value as 'area' | 'thesis')}>
              <option value="area">{t('map.graph.lens_area')}</option>
              <option value="thesis">{t('map.graph.lens_thesis')}</option>
            </select>
          </label>
          {lensKind === 'area' &&
            (facets.length ? (
              <label>
                {t('map.graph.color_by')}{' '}
                <select value={facet ?? ''} onChange={(e) => setFacet(e.target.value)}>
                  {facets.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.key}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="muted">{t('map.graph.no_facets')}</span>
            ))}
          <label>
            <input type="checkbox" checked={showCitations} onChange={(e) => setShowCitations(e.target.checked)} /> {t('map.graph.citations')}
          </label>
          <label>
            <input type="checkbox" checked={showSimilarity} onChange={(e) => setShowSimilarity(e.target.checked)} /> {t('map.graph.similarity')}
          </label>
          <label>
            {t('map.graph.threshold', { value: threshold.toFixed(2) })}{' '}
            <input type="range" min={0} max={1} step={0.05} value={threshold} disabled={!showSimilarity} onChange={(e) => setThreshold(Number(e.target.value))} />
          </label>
          <label title={visibleIds ? undefined : t('map.graph.library_filters_unavailable')}>
            <input type="checkbox" checked={useLibraryFilters} disabled={!visibleIds} onChange={(e) => setUseLibraryFilters(e.target.checked)} />{' '}
            {t('map.graph.apply_library_filters')}
          </label>
          <button onClick={() => void exportPng()}>{t('map.graph.export_png')}</button>
        </div>
        {model?.available && model.state === 'missing' && !model.downloading && (
          <div className="banner warning">
            <span>{t('map.graph.model_missing')}</span>
            <button onClick={() => void window.research.models.download().then(refreshModel)}>{t('map.graph.download_model')}</button>
          </div>
        )}
        {notice && <div className={`banner${notice.error ? ' error' : ''}`}>{notice.text}</div>}
        <div className="graph-canvas" ref={container} />
        {data?.nodes.length === 0 && <div className="graph-empty muted">{t('map.graph.empty')}</div>}
        <div className="small muted">{hover ? reasonsText(t, hover) : t('map.graph.hover_hint')}</div>
        <ul className="legend small">
          {legend.map((item) => (
            <li key={item.label}>
              <span className="swatch" style={{ background: item.color }} />
              {t('map.graph.legend_count', { label: legendLabel(item.label), count: item.count })}
            </li>
          ))}
        </ul>
      </div>
      {selected && (
        <aside className="graph-side">
          <div className="pad">
            <button className="small" onClick={() => setSelected(null)}>
              {t('map.graph.close_detail')}
            </button>
          </div>
          <PaperDetail id={selected} />
        </aside>
      )}
    </div>
  )
}
