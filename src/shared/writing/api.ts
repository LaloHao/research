/** What the writing view («Redacción») exchanges with the main process. */
import type { ChapterBibReport } from './bibtex'
import type { CiteFormat } from './citations'
import type { LlmModel } from '../summary'
import type { OutlineFacet, OutlinePaper, OutlineRelation } from './outline'

/** The longest text «Verificar citas» accepts. */
export const MAX_CHECK_CHARS = 30_000
/** The longest pasted text «BibTeX» accepts (a chosen file has its own limits, see main/writing/includes.ts). */
export const MAX_BIB_TEXT_CHARS = 2_000_000

/** The keys a text may cite: library papers (with whether their text is indexed) and papers in the trash. */
export interface WritingLibrary {
  papers: { id: string; title: string; year: number | null; hasText: boolean }[]
  trashed: { id: string; title: string }[]
}

/** «BibTeX»'s source: pasted text, or the file the main process's dialog handed a token for (never a path). */
export type WritingSource = { kind: 'text'; text: string; format: CiteFormat } | { kind: 'file'; token: string }

export const SKIP_REASONS = ['outside_folder', 'missing', 'cycle', 'too_deep', 'too_large', 'too_many'] as const
export type SkipReason = (typeof SKIP_REASONS)[number]

export interface ChapterBib {
  report: ChapterBibReport
  /** Files read (relative to the chosen file's folder); empty for pasted text. */
  files: { path: string; format: CiteFormat; citations: number }[]
  skipped: { from: string; path: string; reason: SkipReason }[]
  citations: number
}
export type ChapterBibResult = { ok: true; bib: ChapterBib } | { ok: false; error: string }

/** «Esquema»'s papers: the whole library, the ones the library shows (its filters), or a mapping's included papers. */
export type OutlineScope = { kind: 'library' } | { kind: 'papers'; ids: string[] } | { kind: 'mapping'; mappingId: string }

export interface OutlineData {
  /** The form's single and multi facets, in the form's order. */
  facets: OutlineFacet[]
  papers: OutlinePaper[]
  /** Confirmed typed relations between papers of the set. */
  relations: OutlineRelation[]
}
export type OutlineDataResult = { ok: true; data: OutlineData } | { ok: false; error: string }

/**
 * What a Claude operation of «Redacción» would cost, shown before asking: the learned estimate for its kind, its own
 * cap, and the month's spending with the monthly cap (null: none).
 */
export interface WritingPlan {
  estimateUsd: number
  capUsd: number
  monthSpentUsd: number
  monthCapUsd: number | null
}

/** A writing operation's plan with the model it runs on unless the user picks another. */
export interface WritingRunPlan extends WritingPlan {
  model: LlmModel
}
/** The Claude operations of «Redacción» whose plan the window asks for. */
export const WRITING_PLAN_KINDS = ['draft', 'cite_check', 'outline', 'style'] as const
export type WritingPlanKind = (typeof WRITING_PLAN_KINDS)[number]
