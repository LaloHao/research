import { join } from 'node:path'
import { IndexCache } from '../../src/main/cache/IndexCache'
import { BudgetGuard, limitsFromConfig } from '../../src/main/llm/BudgetGuard'
import { CostLedger } from '../../src/main/llm/CostLedger'
import type { CompleteRequest, CompleteResult, LlmProvider } from '../../src/main/llm/LlmProvider'
import { DEFAULT_EXTRACTION_FORM } from '../../src/main/summary/extractionForm'
import type { LlmOutput } from '../../src/main/summary/llmOutput'
import { Summarizer } from '../../src/main/summary/Summarizer'
import { ProjectStore } from '../../src/main/project/ProjectStore'
import { SUMMARY_TEXT_FIELDS, type ExtractionForm, type ThesisContext } from '../../src/shared/summary'
import { samplePaper } from './papers'
import { tmpDir } from './tmp'

type Response = CompleteResult | Error | ((req: CompleteRequest) => CompleteResult | Error)

export class FakeLlmProvider implements LlmProvider {
  readonly calls: CompleteRequest[] = []
  constructor(private readonly responses: Response[]) {}

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.calls.push(req)
    const next = this.responses.length > 1 ? this.responses.shift()! : this.responses[0]
    const r = typeof next === 'function' ? next(req) : next
    if (r instanceof Error) throw r
    return r
  }
}

/** A schema-valid answer for `form` (and `thesis`, when given), citing `quote` on page 1 everywhere. */
export function llmOutputFor(form: ExtractionForm, quote = 'we fine-tune a BERT model', thesis?: ThesisContext | null): LlmOutput {
  const ev = [{ quote, page: 1 }]
  const fields = Object.fromEntries(SUMMARY_TEXT_FIELDS.map((k) => [k, { value: `${k} text`, evidence: ev }]))
  const relation = thesis
    ? {
        thesis_relation: {
          text: 'relation text',
          research_questions: thesis.research_questions.slice(0, 1).map((q) => q.id),
          score: 4,
          justification: 'addresses the first question',
          evidence: ev
        }
      }
    : {}
  return {
    ...relation,
    fields: {
      ...fields,
      limitations: { value: { stated: ['small dataset'], inferred: [] }, evidence: ev },
      research_type: { value: 'evaluation', evidence: [] }
    } as unknown as LlmOutput['fields'],
    facets: Object.fromEntries(
      form.facets.map((f) => {
        switch (f.type) {
          case 'single':
            return [f.key, { value: f.values[0], proposed: [], evidence: ev }]
          case 'multi':
            return [f.key, { values: [f.values[0]], proposed: [], evidence: ev }]
          case 'text':
            return [f.key, { text: 'not addressed', evidence: [] }]
          case 'scale':
            return [f.key, { score: f.min, justification: 'tangential', evidence: [] }]
        }
      })
    )
  }
}

export const PAPER_TEXT = 'For detection, we fine-tune a BERT model on 12k annotated log lines collected from three services. '.repeat(3)

export async function setupSummaries(opts: { responses?: Response[]; form?: ExtractionForm | null; perBatchUsd?: number; thesis?: ThesisContext } = {}) {
  const store = await ProjectStore.create(await tmpDir(), 'Thesis')
  if (opts.thesis) await store.updateConfig({ thesis: opts.thesis })
  if (opts.form !== null) await store.updateConfig({ extraction_form: opts.form ?? DEFAULT_EXTRACTION_FORM })
  if (opts.perBatchUsd) await store.updateConfig({ llm: { ...store.config.llm, budget: { ...store.config.llm.budget, per_batch_usd: opts.perBatchUsd } } })
  await store.writePaper(samplePaper(), null)
  const cache = IndexCache.open(join(store.cacheDir, 'index.sqlite'))
  cache.upsertPaper(samplePaper(), 'h', true)
  cache.setText('he2017drain', 't', 'ok', [{ index: 0, page: 1, text: PAPER_TEXT }])
  const form = opts.form ?? DEFAULT_EXTRACTION_FORM
  const provider = new FakeLlmProvider(opts.responses ?? [{ value: llmOutputFor(form, undefined, opts.thesis), costUsd: 0.03, model: 'claude-sonnet-5' }])
  const ledger = new CostLedger(store, '11111111-1111-1111-1111-111111111111', () => new Date('2026-10-08T12:00:00.000Z'))
  const budget = new BudgetGuard(() => limitsFromConfig(store.config.llm), () => ledger.monthTotal())
  const summarizer = new Summarizer({ store, cache, provider, budget, ledger, now: () => new Date('2026-10-08T12:00:00.000Z') })
  return { store, cache, provider, ledger, budget, summarizer, form }
}
