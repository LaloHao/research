import { describe, expect, it } from 'vitest'
import { buildOutline, type OutlinePaper } from '../../../src/shared/writing/outline'
import { outlineTargets, parseOutlineProposal, proposalTexts, renderProposedOutline } from '../../../src/shared/writing/outlineProposal'

const paper = (id: string, year: number, facets: OutlinePaper['facets']): OutlinePaper => ({ id, title: `Title ${id}`, year, tldr: null, facets })

const outline = buildOutline({
  papers: [
    paper('a', 2018, { task: { values: ['parsing'], reviewed: true }, data: { values: ['loghub'], reviewed: true } }),
    paper('b', 2020, { task: { values: ['anomaly'], reviewed: true }, data: { values: ['loghub'], reviewed: true } }),
    paper('c', 2021, {})
  ],
  facet: { key: 'task', values: ['parsing', 'compression', 'anomaly'] },
  secondary: { key: 'data', values: ['loghub', 'private'] },
  relations: [],
  onlyReviewed: false
})
const targets = outlineTargets(outline)

const answer = (over: Record<string, unknown> = {}) => ({
  order: ['S2', 'S1', 'G1'],
  sections: [
    { id: 'S1', title: 'Log parsing', opening: 'Parsers came first [[a|p. 1|"we parse logs"]].' },
    { id: 'S1.1', title: 'On Loghub', opening: '' },
    { id: 'U', title: 'Other work', opening: 'Some work fits nowhere [[c|"general survey"]].' }
  ],
  gaps: [{ id: 'G1', note: 'Compression matters for storing sanitized logs.' }],
  ...over
})

describe('outlineTargets', () => {
  it('names sections, subsections, «Sin clasificar» and gaps, with the main order', () => {
    expect(targets.sections.map((s) => [s.id, s.kind, s.value, s.sub, s.papers])).toEqual([
      ['S1', 'section', 'parsing', null, []],
      ['S1.1', 'subsection', 'parsing', 'loghub', ['a']],
      ['S2', 'section', 'anomaly', null, []],
      ['S2.1', 'subsection', 'anomaly', 'loghub', ['b']],
      ['U', 'unclassified', null, null, ['c']]
    ])
    expect(targets.gaps).toEqual([
      { id: 'G1', value: 'compression', secondary: null },
      { id: 'G2', value: 'parsing', secondary: 'private' },
      { id: 'G3', value: 'anomaly', secondary: 'private' }
    ])
    expect(targets.top).toEqual(['S1', 'G1', 'S2'])
    expect([...targets.papers].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('parseOutlineProposal', () => {
  it('accepts the outline’s ids and appends the main ids the order leaves out', () => {
    const r = parseOutlineProposal(answer({ order: ['S2'] }), targets)
    expect(r.ok && r.proposal.order).toEqual(['S2', 'S1', 'G1'])
    expect(r.ok && r.proposal.sections.U.title).toBe('Other work')
    expect(r.ok && r.proposal.gaps.G1).toMatch(/Compression/)
  })

  it('rejects invented or repeated sections and gaps', () => {
    expect(parseOutlineProposal(answer({ sections: [{ id: 'S9', title: 'New', opening: '' }] }), targets).ok).toBe(false)
    expect(parseOutlineProposal(answer({ sections: [{ id: 'S1', title: 'A', opening: '' }, { id: 'S1', title: 'B', opening: '' }] }), targets).ok).toBe(false)
    expect(parseOutlineProposal(answer({ gaps: [{ id: 'G7', note: 'x' }] }), targets).ok).toBe(false)
    expect(parseOutlineProposal(answer({ gaps: [{ id: 'S1', note: 'x' }] }), targets).ok).toBe(false)
  })

  it('rejects an order with unknown, nested or repeated ids', () => {
    expect(parseOutlineProposal(answer({ order: ['S1', 'S3'] }), targets).ok).toBe(false)
    expect(parseOutlineProposal(answer({ order: ['S1.1'] }), targets).ok).toBe(false)
    expect(parseOutlineProposal(answer({ order: ['G2'] }), targets).ok).toBe(false)
    expect(parseOutlineProposal(answer({ order: ['S1', 'S1'] }), targets).ok).toBe(false)
  })

  it('rejects citations of papers outside the outline, malformed markers and titles with markers or line breaks', () => {
    expect(parseOutlineProposal(answer({ sections: [{ id: 'S1', title: 'T', opening: 'X [[zzz2020x|p. 1|"quote"]].' }] }), targets).ok).toBe(false)
    expect(parseOutlineProposal(answer({ gaps: [{ id: 'G1', note: 'Y [[a|p. 1|unquoted]].' }] }), targets).ok).toBe(false)
    expect(parseOutlineProposal(answer({ sections: [{ id: 'S1', title: 'T [[a|"q"]]', opening: '' }] }), targets).ok).toBe(false)
    expect(parseOutlineProposal(answer({ sections: [{ id: 'S1', title: 'T\nU', opening: '' }] }), targets).ok).toBe(false)
  })

  it('rejects answers that do not follow the structure', () => {
    expect(parseOutlineProposal({ order: [], sections: [] }, targets).ok).toBe(false)
    expect(parseOutlineProposal({ ...answer(), extra: 1 }, targets).ok).toBe(false)
    expect(parseOutlineProposal(answer({ sections: [{ id: 'S1', title: '', opening: '' }] }), targets).ok).toBe(false)
    expect(parseOutlineProposal(answer({ sections: [{ id: 'S1', title: 'x'.repeat(201), opening: '' }] }), targets).ok).toBe(false)
  })

  it('lists the texts the app checks, by id', () => {
    const r = parseOutlineProposal(answer(), targets)
    expect(r.ok && proposalTexts(r.proposal).map((t) => t.id)).toEqual(['S1', 'U', 'G1'])
  })
})

describe('renderProposedOutline', () => {
  const parsed = parseOutlineProposal(answer(), targets)
  if (!parsed.ok) throw new Error(parsed.error)
  const checks = { S1: [{ state: 'found' as const, page: 1 }], U: [{ state: 'not_found' as const, page: null }] }

  it('writes Org with the proposed order, titles, openings and gap sentences, citations converted', () => {
    const r = renderProposedOutline(outline, parsed.proposal, { format: 'org', checks })
    const text = r.text
    expect(text.indexOf('* anomaly')).toBeLessThan(text.indexOf('* Log parsing'))
    expect(text.indexOf('* Log parsing')).toBeLessThan(text.indexOf('# HUECO: compression'))
    expect(text).toContain('** On Loghub')
    expect(text).toContain('Parsers came first [cite:@a p. 1].')
    expect(text).toContain('* Other work')
    expect(text).toContain('# NO VERIFICADA: c\nSome work fits nowhere [cite:@c].')
    expect(text).toContain('# HUECO: compression: no papers\n\nCompression matters for storing sanitized logs.')
    expect(r).toMatchObject({ converted: 2, unverified: 1 })
  })

  it('writes LaTeX with the prose escaped and the chosen command', () => {
    const r = renderProposedOutline(outline, parsed.proposal, { format: 'latex', latexCommand: 'parencite', checks })
    expect(r.text).toContain('\\section{Log parsing}\n\nParsers came first \\parencite[p.~1]{a}.')
    expect(r.text).toContain('% NO VERIFICADA: c')
  })

  it('writes Markdown, and keeps the outline as it is without a proposal', () => {
    const r = renderProposedOutline(outline, parsed.proposal, { format: 'markdown', checks })
    expect(r.text).toContain('# Log parsing\n\nParsers came first [@a, p. 1].')
    expect(r.text).toContain('[@c] <!-- no verificada -->')
    const empty = renderProposedOutline(outline, { order: targets.top, sections: {}, gaps: {} }, { format: 'markdown' })
    expect(empty).toEqual({ text: expect.stringContaining('# parsing'), converted: 0, unverified: 0 })
  })
})
