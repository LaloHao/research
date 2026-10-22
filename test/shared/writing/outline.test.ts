import { describe, expect, it } from 'vitest'
import { buildOutline, renderOutline, type OutlineInput, type OutlinePaper } from '../../../src/shared/writing/outline'

const paper = (id: string, year: number | null, facets: OutlinePaper['facets'], tldr: string | null = null): OutlinePaper => ({ id, title: `Title ${id}`, year, tldr, facets })

const papers: OutlinePaper[] = [
  paper('b', 2020, { task: { values: ['parsing'], reviewed: true }, data: { values: ['loghub'], reviewed: true } }, 'B parses logs.'),
  paper('a', 2018, { task: { values: ['parsing', 'anomaly'], reviewed: false }, data: { values: ['private'], reviewed: false } }),
  paper('c', null, { data: { values: ['loghub'], reviewed: true } }),
  paper('d', 2019, { task: { values: ['parsing'], reviewed: true } })
]

const input = (over: Partial<OutlineInput> = {}): OutlineInput => ({
  papers,
  facet: { key: 'task', values: ['parsing', 'anomaly', 'compression'] },
  relations: [
    { from: 'b', to: 'a', type: 'extends' },
    { from: 'b', to: 'zzz', type: 'contradicts' }
  ],
  onlyReviewed: false,
  ...over
})

describe('buildOutline', () => {
  it('groups by the main facet in the form’s order, oldest first, with gaps and unclassified papers', () => {
    const o = buildOutline(input())
    expect(o.sections.map((s) => [s.value, s.papers.map((p) => p.id)])).toEqual([
      ['parsing', ['a', 'd', 'b']],
      ['anomaly', ['a']]
    ])
    expect(o.gaps.values).toEqual(['compression'])
    expect(o.unclassified.map((p) => p.id)).toEqual(['c'])
    expect(o.values).toEqual(['parsing', 'anomaly', 'compression'])
  })

  it('keeps only relations between papers of the set', () => {
    const o = buildOutline(input())
    const b = o.sections[0].papers.find((p) => p.id === 'b')!
    expect(b.relations).toEqual([{ from: 'b', to: 'a', type: 'extends' }])
  })

  it('makes subsections by the secondary facet, with empty combinations as gaps', () => {
    const o = buildOutline(input({ secondary: { key: 'data', values: ['loghub', 'private'] } }))
    const parsing = o.sections[0]
    expect(parsing.subsections.map((s) => [s.value, s.papers.map((p) => p.id)])).toEqual([
      ['loghub', ['b']],
      ['private', ['a']]
    ])
    expect(parsing.papers.map((p) => p.id)).toEqual(['d'])
    expect(o.gaps.combinations).toEqual([{ value: 'anomaly', secondary: 'loghub' }])
  })

  it('counts only reviewed entries with «Solo revisadas»', () => {
    const o = buildOutline(input({ onlyReviewed: true }))
    expect(o.sections.map((s) => s.value)).toEqual(['parsing'])
    expect(o.gaps.values).toEqual(['anomaly', 'compression'])
    expect(o.unclassified.map((p) => p.id)).toEqual(['a', 'c'])
  })

  it('lists values papers have that the form no longer does, after the form’s', () => {
    const o = buildOutline(input({ facet: { key: 'task', values: ['anomaly'] } }))
    expect(o.values).toEqual(['anomaly', 'parsing'])
  })

  it('ignores a secondary facet equal to the main one', () => {
    expect(buildOutline(input({ secondary: { key: 'task', values: [] } })).secondary).toBeNull()
  })
})

describe('renderOutline', () => {
  const outline = buildOutline(input({ papers: papers.slice(0, 2), secondary: { key: 'data', values: ['loghub', 'private'] }, question: { id: 'RQ1', text: 'How?' } }))

  it('exports LaTeX with sections, \\cite per paper, escaped text and gaps as comments', () => {
    const tex = renderOutline(outline, { format: 'latex' })
    expect(tex).toContain('% Outline by task / data; research question RQ1: How?')
    expect(tex).toContain('\\section{parsing}\n\n\\subsection{loghub}\n\\begin{itemize}\n  \\item \\cite{b} Title b (2020). B parses logs. \\cite{b} extends \\cite{a}.\n\\end{itemize}')
    expect(tex).toContain('% HUECO: anomaly × loghub: no papers')
    expect(tex).toContain('% HUECO: compression: no papers')
  })

  it('exports Org headings and org-cite, with gaps as comment lines', () => {
    const org = renderOutline(outline, { format: 'org' })
    expect(org).toContain('* parsing\n\n** loghub\n- [cite:@b] Title b (2020). B parses logs. [cite:@b] extends [cite:@a].')
    expect(org).toContain('# HUECO: compression: no papers')
    expect(org.startsWith('# Outline by task')).toBe(true)
  })

  it('exports Markdown headings and pandoc citations, with gaps as HTML comments', () => {
    const md = renderOutline(outline, { format: 'markdown' })
    expect(md).toContain('# parsing\n\n## loghub\n- [@b] Title b (2020).')
    expect(md).toContain('<!-- HUECO: compression: no papers -->')
  })

  it('uses the labels it is given and adds «Sin clasificar»', () => {
    const o = buildOutline(input())
    const org = renderOutline(o, {
      format: 'org',
      labels: {
        value: (_f, v) => v.toUpperCase(),
        unclassified: 'Sin clasificar',
        gapValue: (v) => `${v} sin papers`,
        gapCombination: (v, s) => `${v} y ${s}`,
        relation: (_t, from, to) => `${from} extiende a ${to}`,
        header: () => 'Esquema'
      }
    })
    expect(org).toContain('* PARSING')
    expect(org).toContain('# HUECO: COMPRESSION sin papers')
    expect(org).toContain('* Sin clasificar\n- [cite:@c] Title c.')
    expect(org).toContain('[cite:@b] extiende a [cite:@a]')
  })

  it('escapes LaTeX in titles and summaries', () => {
    const o = buildOutline(input({ papers: [paper('x', 2020, { task: { values: ['parsing'], reviewed: true } }, '50% faster & more_robust')] }))
    expect(renderOutline(o, { format: 'latex' })).toContain('50\\% faster \\& more\\_robust')
  })
})
