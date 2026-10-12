import type { TFunction } from 'i18next'
import {
  criterionText,
  QUEUE_FILTERS,
  type OpenAlexType,
  type Phase,
  type PhaseView,
  type ProtocolDraft,
  type ProtocolFile,
  type QueueFilter,
  type ScreeningPlan,
  type Search
} from '../../shared/mapping'
import type { PaperKind } from '../../shared/schemas'
import type { ThesisContext } from '../../shared/summary'
import { locateInOriginal } from '../../shared/textMatch'
import type { PrismaLabels } from './prismaSvg'

export type ScreeningCommand =
  | { kind: 'include' }
  | { kind: 'exclude'; criterion: string }
  | { kind: 'choose_exclusion' }
  | { kind: 'close_list' }
  | { kind: 'uncertain' }
  | { kind: 'not_retrieved' }
  | { kind: 'accept' }
  | { kind: 'undo' }
  | { kind: 'next' }
  | { kind: 'prev' }

/**
 * What a key does in the screening queue (null: nothing). `E` applies the only exclusion criterion, or opens the list;
 * with the list open, 1–9 picks a criterion and Esc closes it. `N` (not retrieved) exists only on full text.
 */
export function screeningCommand(key: string, ctx: { phase: Phase; choosing: boolean; exclusions: string[] }): ScreeningCommand | null {
  if (ctx.choosing) {
    if (/^[1-9]$/.test(key)) {
      const criterion = ctx.exclusions[Number(key) - 1]
      return criterion ? { kind: 'exclude', criterion } : null
    }
    if (key === 'Escape') return { kind: 'close_list' }
  }
  switch (key) {
    case 'i':
    case 'I':
      return { kind: 'include' }
    case 'e':
    case 'E':
      if (ctx.exclusions.length === 1) return { kind: 'exclude', criterion: ctx.exclusions[0] }
      return ctx.exclusions.length > 1 ? { kind: 'choose_exclusion' } : null
    case 'd':
    case 'D':
      return { kind: 'uncertain' }
    case 'n':
    case 'N':
      return ctx.phase === 'full_text' ? { kind: 'not_retrieved' } : null
    case 'a':
    case 'A':
      return { kind: 'accept' }
    case 'u':
    case 'U':
      return { kind: 'undo' }
    case 'ArrowRight':
      return { kind: 'next' }
    case 'ArrowLeft':
      return { kind: 'prev' }
    default:
      return null
  }
}

/** After the queue reloads: the record that was current if it is still listed, else the next one that is, else the last. */
export function keepPosition(previous: string[], index: number, next: string[]): number {
  for (let i = index; i < previous.length; i++) {
    const at = next.indexOf(previous[i])
    if (at >= 0) return at
  }
  return Math.max(0, next.length - 1)
}

export function filtersFor(phase: Phase): QueueFilter[] {
  return phase === 'title_abstract' ? QUEUE_FILTERS.filter((f) => f !== 'not_retrieved') : [...QUEUE_FILTERS]
}

export function draftOf(file: ProtocolFile): ProtocolDraft {
  const p = file.protocol
  const items = (list: { id: string; text: string }[]): { id: string | null; text: string }[] => list.map(({ id, text }) => ({ id, text }))
  return {
    title: p.title,
    objective: p.objective,
    research_questions: items(p.research_questions),
    inclusion: items(p.inclusion),
    exclusion: items(p.exclusion),
    years: { from: p.years.from, to: p.years.to },
    publication_types: [...p.publication_types]
  }
}

export function sameDraft(a: ProtocolDraft, b: ProtocolDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The years `ProtocolDraftSchema` accepts. */
const MIN_YEAR = 1800
const MAX_YEAR = 2200

/** es.json keys of what keeps the draft from being saved; empty when it can be. */
export function draftProblems(d: ProtocolDraft): string[] {
  const out: string[] = []
  if (!d.title.trim()) out.push('mappings.protocol.errors.title')
  if ([...d.research_questions, ...d.inclusion, ...d.exclusion].some((item) => !item.text.trim())) out.push('mappings.protocol.errors.empty_item')
  const outOfRange = (y: number | null): boolean => y !== null && (!Number.isInteger(y) || y < MIN_YEAR || y > MAX_YEAR)
  if (outOfRange(d.years.from) || outOfRange(d.years.to) || (d.years.from !== null && d.years.to !== null && d.years.from > d.years.to)) {
    out.push('mappings.protocol.errors.years')
  }
  return out
}

/** «Copiar las preguntas de la tesis»: the thesis's questions the draft does not have yet (same text, ignoring case), as new items. */
export function withThesisQuestions(d: ProtocolDraft, thesis: Pick<ThesisContext, 'research_questions'>): ProtocolDraft {
  const have = new Set(d.research_questions.map((q) => q.text.trim().toLowerCase()))
  const added = thesis.research_questions.filter((q) => !have.has(q.text.trim().toLowerCase())).map((q) => ({ id: null, text: q.text }))
  return { ...d, research_questions: [...d.research_questions, ...added] }
}

const OPENALEX_BY_KIND: Partial<Record<PaperKind, OpenAlexType>> = {
  article: 'article',
  conference: 'article',
  preprint: 'preprint',
  book: 'book',
  chapter: 'book-chapter',
  thesis: 'dissertation',
  report: 'report'
}

/** The OpenAlex types the search form starts with, from the protocol's accepted types (conference papers are articles there). */
export function openAlexTypesFor(kinds: readonly PaperKind[]): OpenAlexType[] {
  return [...new Set(kinds.flatMap((k) => OPENALEX_BY_KIND[k] ?? []))]
}

/**
 * «E1 · texto», worded as in protocol `version` (the decision's or suggestion's), so a later rewording never relabels
 * an old decision; without a version, the current wording, else the latest earlier version that had it.
 */
export function criterionLabel(file: ProtocolFile, id: string, version?: number | null): string {
  const text = criterionText(file, id, version ?? undefined)
  return text ? `${id} · ${text}` : id
}

export function phaseLabel(t: TFunction, view: Pick<PhaseView, 'state' | 'criterion' | 'protocolVersion'>, file: ProtocolFile): string {
  const state = t(`mappings.state.${view.state}`)
  return view.criterion ? `${state} · ${criterionLabel(file, view.criterion, view.protocolVersion)}` : state
}

export function searchSource(t: TFunction, s: Search): string {
  if (s.kind === 'library') return t('mappings.sources.library')
  if (s.kind === 'snowball') {
    return t('mappings.searches.snowball_label', { iteration: s.origin?.iteration ?? 1, direction: t(`mappings.searches.directions.${s.origin?.direction ?? 'both'}`) })
  }
  return s.database
}

export function searchFilters(s: Search): string {
  return Object.entries(s.filters)
    .map(([key, value]) => `${key}: ${value}`)
    .join(' · ')
}

const usd = (n: number): string => n.toFixed(2)

/** The lines of «Sugerir cribado»'s confirmation: records, calls and estimate; the caps; the month; papers without text. */
export function planLines(t: TFunction, plan: ScreeningPlan): string[] {
  return [
    t('mappings.screening.suggest_confirm', { count: plan.count, calls: plan.calls, cost: usd(plan.estimateUsd) }),
    t('mappings.screening.suggest_caps', { call: usd(plan.perCallUsd), batch: usd(plan.batchCapUsd) }),
    plan.monthCapUsd === null
      ? t('mappings.screening.month_no_cap', { spent: usd(plan.monthSpentUsd) })
      : t('mappings.screening.month', { spent: usd(plan.monthSpentUsd), cap: usd(plan.monthCapUsd) }),
    ...(plan.withoutText > 0 ? [t('mappings.screening.without_text', { count: plan.withoutText })] : [])
  ]
}

/** The quote inside the text (matched like the evidence checks), for a highlight; null when it is not there. */
export function highlight(text: string, quote: string | null): { before: string; match: string; after: string } | null {
  if (!quote) return null
  const at = locateInOriginal(quote, text)
  if (!at) return null
  return { before: text.slice(0, at.start), match: text.slice(at.start, at.end), after: text.slice(at.end) }
}

export function prismaLabels(t: TFunction, file: ProtocolFile): PrismaLabels {
  return {
    databases: t('mappings.prisma.databases'),
    other: t('mappings.prisma.other'),
    stages: {
      identification: t('mappings.prisma.stages.identification'),
      screening: t('mappings.prisma.stages.screening'),
      included: t('mappings.prisma.stages.included')
    },
    identified: t('mappings.prisma.identified'),
    source: (s) =>
      t('mappings.prisma.source', {
        source: s.kind === 'library' ? t('mappings.prisma.library') : s.kind === 'snowball' ? t('mappings.prisma.snowball') : s.database,
        count: s.count
      }),
    duplicates: (n) => t('mappings.prisma.duplicates', { count: n }),
    screened: (n, pending) => (pending > 0 ? t('mappings.prisma.screened_pending', { count: n, pending }) : t('mappings.prisma.screened', { count: n })),
    excludedScreening: (n) => t('mappings.prisma.excluded_screening', { count: n }),
    sought: (n) => t('mappings.prisma.sought', { count: n }),
    notRetrieved: (n) => t('mappings.prisma.not_retrieved', { count: n }),
    assessed: (n, pending) => (pending > 0 ? t('mappings.prisma.assessed_pending', { count: n, pending }) : t('mappings.prisma.assessed', { count: n })),
    excludedFullText: t('mappings.prisma.excluded_full_text'),
    reason: (criterion, n) => t('mappings.prisma.reason', { criterion: criterionLabel(file, criterion), count: n }),
    included: (n) => t('mappings.prisma.included', { count: n })
  }
}

/** `prisma-<title in ASCII>.<ext>`, a bare file name the save dialog accepts. */
export function prismaFileName(title: string, ext: 'svg' | 'png'): string {
  const slug =
    title
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'mapeo'
  return `prisma-${slug}.${ext}`
}
