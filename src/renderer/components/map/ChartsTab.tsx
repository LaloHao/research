import * as Plot from '@observablehq/plot'
import type { TFunction } from 'i18next'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CHART_KINDS, type ChartData, type ChartKind, type ChartQuery, type FacetFilter, type FacetOption } from '../../../shared/relations'
import { useEvent } from '../../hooks/useEvent'
import { chartCsv, chartFileName, chartRows, pickFilters, tipLabel, yearColors, type PlotRow } from '../../lib/chartExport'
import { errorText } from '../../lib/errorText'
import { PALETTE } from '../../lib/graphElements'

const SVG_NS = 'http://www.w3.org/2000/svg'
const cssVar = (name: string, fallback: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

function hasRows(data: ChartData): boolean {
  return data.kind === 'bars' ? data.bars.length > 0 : data.kind === 'years' ? data.years.length > 0 : data.cells.length > 0
}

function renderPlot(data: ChartData, t: TFunction, fg: string, bg: string): SVGSVGElement {
  const rows = chartRows(data)
  const fillOpacity = (d: PlotRow): number => (d.reviewed ? 1 : 0.4)
  const title = (d: PlotRow): string => t(d.reviewed ? 'map.charts.tip' : 'map.charts.tip_unreviewed', { label: tipLabel(data, d), count: d.count })
  const style = { background: bg, color: fg, fontSize: '12px' }
  const papers = t('map.charts.papers')
  let plot: ReturnType<typeof Plot.plot>
  switch (data.kind) {
    case 'bars':
      plot = Plot.plot({
        style,
        height: 420,
        marginBottom: 110,
        x: { label: data.facet, tickRotate: -35, domain: data.bars.map((b) => b.value) },
        y: { label: papers, grid: true },
        marks: [
          Plot.barY(rows, { x: 'x', y: 'count', fill: PALETTE[0], fillOpacity }),
          Plot.ruleY([0]),
          Plot.tip(rows, Plot.pointerX(Plot.stackY({ x: 'x', y: 'count', title })))
        ]
      })
      break
    case 'years': {
      const colors = yearColors(data)
      plot = Plot.plot({
        style,
        height: 420,
        x: { label: t('map.charts.year'), type: 'band', tickFormat: 'd' },
        y: { label: papers, grid: true },
        marks: [
          Plot.barY(rows, { x: 'x', y: 'count', fill: (d: PlotRow) => colors.get(d.value ?? '') ?? PALETTE[9], fillOpacity }),
          Plot.ruleY([0]),
          Plot.tip(rows, Plot.pointerX(Plot.stackY({ x: 'x', y: 'count', title })))
        ]
      })
      break
    }
    case 'bubbles':
      plot = Plot.plot({
        style,
        height: Math.max(260, 36 * data.yValues.length + 150),
        marginLeft: 150,
        marginBottom: 110,
        x: { label: data.facet, domain: data.xValues, tickRotate: -35, grid: true },
        y: { label: data.facetY, domain: data.yValues, grid: true },
        r: { range: [3, 24] },
        marks: [Plot.dot(rows, { x: 'x', y: 'y', r: 'count', fill: PALETTE[0], fillOpacity }), Plot.tip(rows, Plot.pointer({ x: 'x', y: 'y', title }))]
      })
      break
  }
  return plot as unknown as SVGSVGElement
}

/** The plot plus, for the per-year chart, its legend drawn inside the SVG so an exported file keeps it. */
function exportableSvg(svg: SVGSVGElement, legend: { label: string; color: string }[], fg: string): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement
  if (!legend.length) return clone
  const width = Number(svg.getAttribute('width'))
  const height = Number(svg.getAttribute('height'))
  const total = height + 8 + 18 * legend.length
  const out = document.createElementNS(SVG_NS, 'svg')
  out.setAttribute('xmlns', SVG_NS)
  out.setAttribute('width', String(width))
  out.setAttribute('height', String(total))
  out.setAttribute('viewBox', `0 0 ${width} ${total}`)
  out.appendChild(clone)
  legend.forEach((item, i) => {
    const y = height + 8 + 18 * i
    const rect = document.createElementNS(SVG_NS, 'rect')
    rect.setAttribute('x', '8')
    rect.setAttribute('y', String(y))
    rect.setAttribute('width', '10')
    rect.setAttribute('height', '10')
    rect.setAttribute('fill', item.color)
    const text = document.createElementNS(SVG_NS, 'text')
    text.setAttribute('x', '24')
    text.setAttribute('y', String(y + 9))
    text.setAttribute('font-size', '12')
    text.setAttribute('font-family', 'system-ui, sans-serif')
    text.setAttribute('fill', fg)
    text.textContent = item.label
    out.append(rect, text)
  })
  return out
}

async function svgToPng(svg: SVGSVGElement, bg: string): Promise<Uint8Array> {
  const width = Number(svg.getAttribute('width'))
  const height = Number(svg.getAttribute('height'))
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }))
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = width * scale
    canvas.height = height * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('No 2D canvas')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.scale(scale, scale)
    ctx.drawImage(image, 0, 0, width, height)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'))
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Bumps when the OS color scheme changes, so the chart is drawn again with the new theme colors. */
function useColorScheme(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (): void => setDark(scheme.matches)
    scheme.addEventListener('change', update)
    return () => scheme.removeEventListener('change', update)
  }, [])
  return dark
}

export function ChartsTab({ onOpenLibrary }: { onOpenLibrary: (filters: FacetFilter[]) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [facets, setFacets] = useState<FacetOption[]>([])
  const [kind, setKind] = useState<ChartKind>('bars')
  const [facet, setFacet] = useState<string | null>(null)
  const [facetY, setFacetY] = useState<string | null>(null)
  const [onlyReviewed, setOnlyReviewed] = useState(false)
  const [data, setData] = useState<ChartData | null>(null)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const dark = useColorScheme()
  const holder = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement | null>(null)

  const loadFacets = useCallback(() => {
    window.research.map.facets().then(
      (options) => {
        const valid = (key: string | null): boolean => key !== null && options.some((o) => o.key === key)
        setFacets(options)
        setFacet((current) => (valid(current) ? current : (options[0]?.key ?? null)))
        setFacetY((current) => (valid(current) ? current : (options[1]?.key ?? options[0]?.key ?? null)))
      },
      () => setNotice({ error: true, text: errorText(t, 'unknown') })
    )
  }, [t])
  useEffect(loadFacets, [loadFacets])
  useEvent('project-changed', loadFacets)

  const query: ChartQuery | null = useMemo(() => {
    if (!facet) return null
    if (kind === 'bubbles') return facetY ? { kind, facet, facetY, onlyReviewed } : null
    return { kind, facet, onlyReviewed }
  }, [kind, facet, facetY, onlyReviewed])

  const refresh = useCallback(() => {
    if (query) window.research.map.chart(query).then(setData, () => setNotice({ error: true, text: errorText(t, 'unknown') }))
    else setData(null)
  }, [query, t])
  useEffect(refresh, [refresh])
  useEvent('library-changed', refresh)

  const legend = useMemo(() => (data?.kind === 'years' ? [...yearColors(data)].map(([label, color]) => ({ label, color })) : []), [data])

  useEffect(() => {
    const target = holder.current
    if (!target) return
    target.replaceChildren()
    svg.current = null
    if (!data || !hasRows(data)) return
    const plot = renderPlot(data, t, cssVar('--text', '#222222'), cssVar('--bg', '#ffffff'))
    // Plot pins its tooltip on pointerdown; a pinned tip ignores the pointer, so the next click would open the old mark.
    // Keeping the tip unpinned makes `plot.value` always the mark under the pointer.
    plot.addEventListener('pointerdown', (event) => event.stopImmediatePropagation(), { capture: true })
    plot.addEventListener('click', () => {
      const picked = (plot as unknown as { value?: PlotRow | null }).value
      if (picked) onOpenLibrary(pickFilters(data, picked))
    })
    target.append(plot)
    svg.current = plot
  }, [data, t, onOpenLibrary, dark])

  const save = async (ext: 'svg' | 'png' | 'csv'): Promise<void> => {
    if (!data) return
    setNotice(null)
    try {
      let payload: string | Uint8Array
      if (ext === 'csv') payload = chartCsv(data)
      else {
        if (!svg.current) return
        const full = exportableSvg(svg.current, legend, cssVar('--text', '#222222'))
        payload = ext === 'svg' ? new XMLSerializer().serializeToString(full) : await svgToPng(full, cssVar('--bg', '#ffffff'))
      }
      const result = await window.research.exports.save(chartFileName(data, ext), payload)
      if (result.ok) setNotice({ error: false, text: t('map.graph.exported', { path: result.path }) })
      else if (result.error) setNotice({ error: true, text: errorText(t, result.error) })
    } catch {
      setNotice({ error: true, text: errorText(t, 'unknown') })
    }
  }

  if (facets.length === 0) return <div className="center muted">{t('map.charts.no_facets')}</div>

  return (
    <div className="charts">
      <div className="row small">
        <label>
          {t('map.charts.kind')}{' '}
          <select value={kind} onChange={(e) => setKind(e.target.value as ChartKind)}>
            {CHART_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`map.charts.kinds.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('map.charts.facet')}{' '}
          <select value={facet ?? ''} onChange={(e) => setFacet(e.target.value)}>
            {facets.map((f) => (
              <option key={f.key} value={f.key}>
                {f.key}
              </option>
            ))}
          </select>
        </label>
        {kind === 'bubbles' && (
          <label>
            {t('map.charts.facet_y')}{' '}
            <select value={facetY ?? ''} onChange={(e) => setFacetY(e.target.value)}>
              {facets.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.key}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <input type="checkbox" checked={onlyReviewed} onChange={(e) => setOnlyReviewed(e.target.checked)} /> {t('map.charts.only_reviewed')}
        </label>
        <button onClick={() => void save('svg')}>{t('map.charts.export_svg')}</button>
        <button onClick={() => void save('png')}>{t('map.charts.export_png')}</button>
        <button onClick={() => void save('csv')}>{t('map.charts.export_csv')}</button>
      </div>
      <p className="muted small">
        {t('map.charts.click_hint')} {!onlyReviewed && t('map.charts.dim_note')}
      </p>
      {notice && <div className={`banner${notice.error ? ' error' : ''}`}>{notice.text}</div>}
      {data && !hasRows(data) && <p className="muted">{t('map.charts.empty')}</p>}
      <div className="chart-holder" ref={holder} />
      {legend.length > 0 && (
        <ul className="legend small">
          {legend.map((item) => (
            <li key={item.label}>
              <span className="swatch" style={{ background: item.color }} />
              {item.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
