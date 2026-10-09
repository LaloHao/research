import { describe, expect, it } from 'vitest'
import { renderSummaryMarkdown } from '../../../src/main/summary/markdown'
import { sampleExtraction, sampleSummary } from '../../helpers/summaries'

describe('renderSummaryMarkdown', () => {
  it('renders a readable summary with evidence and classification', () => {
    const md = renderSummaryMarkdown(
      'Drain',
      sampleSummary({ method: { value: 'Fixed depth tree', status: 'verified', evidence: [{ quote: 'we use a tree', page: 3, found: true }] } }),
      sampleExtraction({ technique: { values: ['ner'], proposed: ['tokenization'], status: 'generated', evidence: [] } })
    )
    expect(md.startsWith('# Drain\n')).toBe(true)
    expect(md).toContain('## Method\n\nFixed depth tree')
    expect(md).toContain('> "we use a tree" (p. 3)')
    expect(md).toContain('- **technique**: ner (proposed: tokenization)')
    expect(md).toContain('- **relevance**: 4 — j')
  })
})
