import type { TFunction } from 'i18next'
import {
  criterionText,
  hasFilterSeparator,
  quotedWildcard,
  QUEUE_FILTERS,
  SEARCH_CAP,
  SNOWBALL_CAP,
  type OpenAlexCount,
  type OpenAlexSearchRequest,
  type OpenAlexType,
  type Phase,
  type PhaseView,
  type ProtocolDraft,
  type ProtocolFile,
  type QueueFilter,
  type ScreeningPlan,
  type Search,
  type SnowballDirection,
  YEAR_MAX,
  YEAR_MIN
} from '../../shared/mapping'
import type { PaperKind } from '../../shared/schemas'
import type { ThesisContext } from '../../shared/summary'
import { locateInOriginal } from '../../shared/textMatch'
import { errorText } from './errorText'
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

/** es.json keys of what keeps the draft from being saved; empty when it can be. */
export function draftProblems(d: ProtocolDraft): string[] {
  const out: string[] = []
  if (!d.title.trim()) out.push('mappings.protocol.errors.title')
  if ([...d.research_questions, ...d.inclusion, ...d.exclusion].some((item) => !item.text.trim())) out.push('mappings.protocol.errors.empty_item')
  const outOfRange = (y: number | null): boolean => y !== null && (!Number.isInteger(y) || y < YEAR_MIN || y > YEAR_MAX)
  if (outOfRange(d.years.from) || outOfRange(d.years.to) || (d.years.from !== null && d.years.to !== null && d.years.from > d.years.to)) {
    out.push('mappings.protocol.errors.years')
  }
  return out
}

/** A year field as typed: empty is no year; anything else (even half typed, or not a number) is checked by `draftProblems`. */
export function yearValue(text: string): number | null {
  return text.trim() === '' ? null : Number(text)
}

/**
 * The saved protocol changed under a draft being edited (a sync, another window): a new version, or the same version
 * edited in place before any decision. `edit` is the version and the protocol the editing started from.
 */
export function draftOutdated(edit: { base: number; from: ProtocolDraft }, file: ProtocolFile): boolean {
  return edit.base !== file.version || !sameDraft(edit.from, draftOf(file))
}

/** «Copiar las preguntas de la tesis»: the thesis's questions the draft does not have yet (same text, ignoring case), as new items. */
export function withThesisQuestions(d: ProtocolDraft, thesis: Pick<ThesisContext, 'research_questions'>): ProtocolDraft {
  const have = new Set(d.research_questions.map((q) => q.text.trim().toLowerCase()))
  const added = thesis.research_questions.filter((q) => !have.has(q.text.trim().toLowerCase())).map((q) => ({ id: null, text: q.text }))
  return { ...d, research_questions: [...d.research_questions, ...added] }
}

const OPENALEX_BY_KIND: Partial<Record<PaperKind, OpenAlexType>> = {
  article: 'article',
  conference: 'conference-paper',
  preprint: 'preprint',
  book: 'book',
  chapter: 'book-chapter',
  thesis: 'dissertation',
  report: 'report'
}

/** The OpenAlex types the search form starts with, from the protocol's accepted types. */
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

/** «En: título y resumen» for an OpenAlex search that recorded the fields it looked in; null otherwise. */
export function searchField(t: TFunction, s: Search): string | null {
  return s.field ? t('mappings.searches.field', { field: t(`mappings.searches.fields.${s.field}`, { defaultValue: s.field }) }) : null
}

/**
 * A search's figures in the log: the rows it received (read, for an export or the library), OpenAlex's own total when
 * it gave one, and the distinct records the mapping holds from it now (its rows less the works OpenAlex repeated
 * while paging and the records later merged as duplicates).
 */
export function searchCountParts(t: TFunction, s: Search, held: number): string[] {
  const received = s.kind === 'import' || s.kind === 'library' ? 'count_read' : 'count_received'
  return [
    t(`mappings.searches.${received}`, { count: s.count }),
    ...(s.total === null ? [] : [t(s.kind === 'openalex' ? 'mappings.searches.count_total' : 'mappings.searches.count_found', { count: s.total })]),
    t('mappings.searches.count_held', { count: held })
  ]
}

/** How a discarded search reads in the log: completed by a later search (its date), or discarded with the user's reason. */
export function discardedText(t: TFunction, s: Search, searches: readonly Search[]): string | null {
  const d = s.discarded
  if (!d) return null
  if (d.replaced_by) {
    const by = searches.find((x) => x.id === d.replaced_by)
    return t('mappings.searches.completed_by', { date: new Date(by?.at ?? d.at).toLocaleString() })
  }
  return t('mappings.searches.discarded', { date: new Date(d.at).toLocaleDateString(), reason: d.reason })
}

/** The OpenAlex form as typed. */
export interface OpenAlexForm {
  query: string
  fromYear: string
  toYear: string
  types: OpenAlexType[]
  cap: string
}

const validYear = (n: number | null): boolean => n === null || (Number.isInteger(n) && n >= YEAR_MIN && n <= YEAR_MAX)

/**
 * The request «Buscar» asks to confirm, or why it cannot run yet: no search string, a string OpenAlex would refuse or
 * read differently (a filter separator, a wildcard inside a quoted phrase: `phrase` names it), or a year out of range
 * (or the first after the last). The cap is kept within 1 and the maximum; an unreadable cap is the default.
 */
export function openAlexRequest(
  form: OpenAlexForm
): { ok: true; req: OpenAlexSearchRequest } | { ok: false; problem: 'query' | 'separator' | 'years' } | { ok: false; problem: 'quoted_wildcard'; phrase: string } {
  const query = form.query.trim()
  if (!query) return { ok: false, problem: 'query' }
  if (hasFilterSeparator(query)) return { ok: false, problem: 'separator' }
  const phrase = quotedWildcard(query)
  if (phrase) return { ok: false, problem: 'quoted_wildcard', phrase }
  const fromYear = yearValue(form.fromYear)
  const toYear = yearValue(form.toYear)
  if (!validYear(fromYear) || !validYear(toYear) || (fromYear !== null && toYear !== null && fromYear > toYear)) return { ok: false, problem: 'years' }
  const typed = Number(form.cap)
  const cap = form.cap.trim() !== '' && Number.isFinite(typed) ? Math.min(Math.max(Math.round(typed), 1), SEARCH_CAP.max) : SEARCH_CAP.default
  return { ok: true, req: { query, fromYear, toYear, types: [...new Set(form.types)], cap } }
}

/** OpenAlex's search pages hold 100 results. */
const OPENALEX_PAGE = 100

/**
 * What OpenAlex's count says about the cap, for the confirmation: `fits` (everything comes), `raise` (more than the
 * cap, but a cap of `total` is allowed: «Subir el tope»), `too_many` (more than any cap: refine the string), or
 * `unknown` (the count could not be read).
 */
export type CountAdvice = { kind: 'unknown'; error: string } | { kind: 'fits' | 'raise' | 'too_many'; total: number; fetched: number }

export function countAdvice(req: Pick<OpenAlexSearchRequest, 'cap'>, count: OpenAlexCount): CountAdvice {
  if (!count.ok) return { kind: 'unknown', error: count.error }
  const { total } = count
  const fetched = Math.min(total, req.cap)
  if (total <= req.cap) return { kind: 'fits', total, fetched }
  return { kind: total <= SEARCH_CAP.max ? 'raise' : 'too_many', total, fetched }
}

/** The cap «Subir el tope a N» sets; null when the count does not call for one. */
export function raisedCap(req: Pick<OpenAlexSearchRequest, 'cap'>, count: OpenAlexCount): number | null {
  const advice = countAdvice(req, count)
  return advice.kind === 'raise' ? advice.total : null
}

/**
 * The confirmation of «Buscar en OpenAlex»: what OpenAlex's count says (when it was asked: how many results there are
 * and how many come, or that the count failed and why), the years and types it filters by, and that it costs no money.
 */
export function openAlexPlanLines(t: TFunction, req: OpenAlexSearchRequest, count?: OpenAlexCount): string[] {
  const { fromYear: from, toYear: to } = req
  const advice = count ? countAdvice(req, count) : null
  const head =
    advice === null || advice.kind === 'unknown'
      ? [
          ...(advice ? [t('mappings.searches.count_failed', { error: errorText(t, advice.error) })] : []),
          t('mappings.searches.confirm_openalex', { cap: req.cap, pages: Math.ceil(req.cap / OPENALEX_PAGE) })
        ]
      : [
          advice.total === 0
            ? t('mappings.searches.confirm_count_none')
            : t('mappings.searches.confirm_count', { total: advice.total, fetched: advice.fetched, pages: Math.ceil(advice.fetched / OPENALEX_PAGE) }),
          ...(advice.kind === 'too_many' ? [t('mappings.searches.count_too_many', { max: SEARCH_CAP.max })] : [])
        ]
  return [
    ...head,
    t('mappings.searches.confirm_field'),
    from !== null && to !== null
      ? t('mappings.searches.confirm_years_range', { from, to })
      : from !== null
        ? t('mappings.searches.confirm_years_from', { from })
        : to !== null
          ? t('mappings.searches.confirm_years_to', { to })
          : t('mappings.searches.confirm_years_any'),
    req.types.length > 0
      ? t('mappings.searches.confirm_types', { types: req.types.map((type) => t(`mappings.openalex_types.${type}`)).join(', ') })
      : t('mappings.searches.confirm_types_any'),
    t('mappings.searches.confirm_free')
  ]
}

/** The number the next snowballing iteration gets: snowballing searches so far (discarded ones too) + 1, as the log numbers it. */
export function nextSnowballIteration(searches: readonly Search[]): number {
  return searches.filter((s) => s.kind === 'snowball').length + 1
}

/** The confirmation of «Buscar candidatos»: the iteration, its direction, the records it starts from and how many works at most. */
export function snowballPlanLines(t: TFunction, plan: { direction: SnowballDirection; included: number; iteration: number }): string[] {
  return [
    t('mappings.searches.confirm_snowball', { iteration: plan.iteration, direction: t(`mappings.searches.directions.${plan.direction}`), count: plan.included }),
    t('mappings.searches.confirm_snowball_cap', { cap: SNOWBALL_CAP }),
    t('mappings.searches.confirm_free')
  ]
}

const usd = (n: number): string => n.toFixed(2)

/** An estimate as the confirmations show it: «~$1.23», or «< $0.01» for a smaller one (never «~$0.00»). */
export function approxUsd(n: number): string {
  return n >= 0.005 ? `~$${n.toFixed(2)}` : '< $0.01'
}

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
