import type { ExtractionFile, FieldStatus, SummaryFile, ThesisContext } from '../../src/shared/summary'

const f = <T>(value: T, status: FieldStatus = 'generated') => ({ value, status, evidence: [] })

export function sampleSummary(overrides: Partial<SummaryFile['fields']> = {}): SummaryFile {
  return {
    schema_version: 1,
    generated: { model: 'sonnet', at: '2026-10-08T00:00:00.000Z', cost_usd_est: 0.04, prompt_version: 1, language: 'en' },
    fields: {
      tldr: f('t'),
      problem: f('p'),
      contribution: f('c'),
      method: f('m'),
      evaluation: f('e'),
      results: f('r'),
      limitations: f({ stated: [] as string[], inferred: [] as string[] }),
      future_work: f('fw'),
      research_type: f('evaluation' as const),
      ...overrides
    }
  }
}

export function sampleExtraction(facets: ExtractionFile['facets'] = {}, formHash = 'h'): ExtractionFile {
  return {
    schema_version: 1,
    form_hash: formHash,
    facets: { relevance: { score: 4, justification: 'j', proposed: [], status: 'generated', evidence: [] }, ...facets }
  }
}

export const sampleThesis: ThesisContext = {
  title: 'Privacy-preserving log analysis',
  description: 'Sanitizing operational logs before sending them to cloud LLMs',
  research_questions: [
    { id: 'RQ1', text: 'Which sanitization techniques preserve utility?' },
    { id: 'RQ2', text: 'How can outputs be traced back to evidence?' }
  ]
}
