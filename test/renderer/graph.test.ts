import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import {
  buildElements,
  initialPosition,
  layoutPlan,
  lensColors,
  nodeSize,
  NO_VALUE,
  NONE_COLOR,
  OTHER_VALUES,
  PALETTE,
  shortLabel,
  THESIS_COLORS
} from '../../src/renderer/lib/graphElements'
import { reasonsText, reasonText } from '../../src/renderer/lib/reasons'
import type { GraphData, GraphNode } from '../../src/shared/relations'

const t = ((key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key)) as unknown as TFunction
const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({ id, title: `Title ${id}`, year: 2020, citedByCount: 0, facets: {}, thesisScore: null, ...over })

const data: GraphData = {
  nodes: [node('a', { facets: { task: ['parsing', 'anonymization'] }, citedByCount: 1000, thesisScore: 5 }), node('b', { facets: { task: ['anonymization'] } }), node('c')],
  citations: [{ source: 'a', target: 'b' }],
  similarities: [
    { source: 'a', target: 'c', score: 0.2, reasons: [] },
    { source: 'b', target: 'c', score: 0.6, reasons: [{ kind: 'coupling', shared: 2 }] }
  ],
  typed: []
}

describe('graph lenses', () => {
  it('colors the area lens by the value of each paper that is most frequent in the library', () => {
    const { color, legend } = lensColors(data.nodes, { kind: 'area', facet: 'task' })
    expect(color.get('a')).toBe(PALETTE[0])
    expect(color.get('b')).toBe(PALETTE[0])
    expect(color.get('c')).toBe(NONE_COLOR)
    expect(legend).toEqual([
      { label: 'anonymization', color: PALETTE[0], count: 2 },
      { label: NO_VALUE, color: NONE_COLOR, count: 1 }
    ])
  })

  it('groups the values that do not fit the palette as other values', () => {
    const many = Array.from({ length: 11 }, (_, i) => node(`n${i}`, { facets: { task: [`v${String(i).padStart(2, '0')}`] } }))
    const { legend } = lensColors(many, { kind: 'area', facet: 'task' })
    expect(legend).toHaveLength(10)
    expect(legend.at(-1)).toEqual({ label: OTHER_VALUES, color: PALETTE[9], count: 2 })
  })

  it('colors the thesis lens by relevance, gray without a relation', () => {
    const { color, legend } = lensColors(data.nodes, { kind: 'thesis' })
    expect(color.get('a')).toBe(THESIS_COLORS[4])
    expect(legend).toEqual([
      { label: '5', color: THESIS_COLORS[4], count: 1 },
      { label: NO_VALUE, color: NONE_COLOR, count: 2 }
    ])
  })
})

describe('graph elements', () => {
  it('sizes nodes on a log scale and shortens labels', () => {
    expect(nodeSize(null)).toBe(14)
    expect(nodeSize(999)).toBeCloseTo(32)
    expect(nodeSize(1e9)).toBe(48)
    expect(shortLabel('A very long title that keeps going and going forever', 2020)).toBe('A very long title that keeps going and… (2020)')
    expect(shortLabel('Short', null)).toBe('Short')
  })

  it('builds nodes and edges, honoring the edge toggles, the threshold and the library filter', () => {
    const all = buildElements(data, { lens: { kind: 'area', facet: 'task' }, showCitations: true, showSimilarity: true, threshold: 0.5, visibleIds: null })
    expect(all.filter((e) => e.group === 'nodes')).toHaveLength(3)
    expect(all.filter((e) => e.classes === 'citation').map((e) => e.data.id)).toEqual(['c:a>b'])
    expect(all.filter((e) => e.classes === 'similarity').map((e) => e.data.id)).toEqual(['s:b|c'])
    const onlyAB = buildElements(data, { lens: { kind: 'thesis' }, showCitations: false, showSimilarity: true, threshold: 0, visibleIds: new Set(['a', 'b']) })
    expect(onlyAB.map((e) => e.data.id)).toEqual(['a', 'b'])
  })
})

describe('graph layout', () => {
  it('waits for real nodes before spending the randomized first layout', () => {
    expect(layoutPlan(null, [])).toEqual({ relayout: false, randomize: false })
    expect(layoutPlan(null, ['b', 'a'])).toEqual({ relayout: true, randomize: true })
  })

  it('relayouts from the current positions only when the set of papers changes', () => {
    expect(layoutPlan(new Set(['a', 'b']), ['b', 'a'])).toEqual({ relayout: false, randomize: false })
    expect(layoutPlan(new Set(['a', 'b']), ['a', 'b', 'c'])).toEqual({ relayout: true, randomize: false })
    expect(layoutPlan(new Set(['a', 'b']), ['a'])).toEqual({ relayout: true, randomize: false })
    expect(layoutPlan(new Set(['a', 'b']), [])).toEqual({ relayout: false, randomize: false })
    // No paper keeps a position: start over.
    expect(layoutPlan(new Set(['a', 'b']), ['c', 'd'])).toEqual({ relayout: true, randomize: true })
  })

  it('places a new node next to a neighbour, else inside the current graph', () => {
    const box = { x1: 0, y1: 10, x2: 100, y2: 30 }
    expect(initialPosition({ x: 5, y: 7 }, box, () => 0.5)).toEqual({ x: 5, y: 7 })
    expect(initialPosition(null, box, () => 0.5)).toEqual({ x: 50, y: 20 })
    expect(initialPosition(null, null, () => 0.5)).toBeUndefined()
  })
})

describe('similarity reasons', () => {
  it('turns each reason into a sentence', () => {
    expect(reasonText(t, { kind: 'coupling', shared: 6 })).toBe('relations.reasons.coupling {"count":6}')
    expect(reasonText(t, { kind: 'cocitation', by: 3 })).toBe('relations.reasons.cocitation {"count":3}')
    expect(reasonText(t, { kind: 'direct', citing: 'a2020x', cited: 'b2021y' })).toBe('relations.reasons.direct {"citing":"a2020x","cited":"b2021y"}')
    expect(reasonText(t, { kind: 'content', cosine: 0.82 })).toBe('relations.reasons.content {"score":"0.82"}')
    expect(
      reasonText(t, {
        kind: 'facets',
        shared: [
          { facet: 'technique', values: ['ner'] },
          { facet: 'task', values: ['anonymization', 'parsing'] }
        ]
      })
    ).toBe('technique: ner · task: anonymization, parsing')
    expect(reasonsText(t, [{ kind: 'coupling', shared: 1 }, { kind: 'content', cosine: 0.9 }])).toBe(
      'relations.reasons.coupling {"count":1} · relations.reasons.content {"score":"0.90"}'
    )
  })
})
