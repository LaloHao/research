import type { TFunction } from 'i18next'
import type { WritingPlan } from '../../shared/writing/api'
import type { CiteFormat } from '../../shared/writing/citations'
import { MAX_DRAFT_PAPERS, type DraftPartial, type DraftStreamUpdate, type DraftSummary } from '../../shared/writing/draft'
import { exportFileName, FILE_EXTENSIONS } from './writing'

/** The version being written, as «Borrador» shows it. */
export interface LiveDraft {
  text: string
  tools: number
  /** The newest stream update applied. */
  seq: number
  status: 'running' | 'error'
  error: string | null
}

export const liveFromPartial = (p: DraftPartial): LiveDraft => ({ text: p.text, tools: p.tools, seq: p.seq, status: 'running', error: null })

/**
 * One stream update of the shown draft applied to what it shows: `start` begins a version, deltas add to the current
 * turn, a new turn starts its text over, the end clears it (an error stays to be read). An update older than what is
 * shown is ignored; `resync` when the update needs a version the window does not know about (it opened mid-run).
 */
export function applyDraftUpdate(live: LiveDraft | null, u: DraftStreamUpdate): { live: LiveDraft | null; resync: boolean } {
  if (live && u.seq <= live.seq) return { live, resync: false }
  if (u.kind === 'start') return { live: { text: '', tools: 0, seq: u.seq, status: 'running', error: null }, resync: false }
  if (u.kind === 'done' || u.kind === 'stopped') return { live: null, resync: true }
  if (u.kind === 'error') return { live: { text: live?.text ?? '', tools: live?.tools ?? 0, seq: u.seq, status: 'error', error: u.error }, resync: true }
  if (!live || live.status !== 'running') return { live, resync: true }
  if (u.kind === 'delta') return { live: { ...live, text: live.text + u.text, seq: u.seq }, resync: false }
  if (u.kind === 'turn') return { live: { ...live, text: '', seq: u.seq }, resync: false }
  return { live: { ...live, tools: live.tools + 1, seq: u.seq }, resync: false }
}

const usd = (n: number): string => n.toFixed(2)

/** The confirmation's lines: the estimate, the draft cap, the month. */
export function planLines(t: TFunction, plan: WritingPlan): string[] {
  return [
    t('writing.draft.confirm_estimate', { cost: plan.estimateUsd > 0 && plan.estimateUsd < 0.01 ? '< $0.01' : `~$${usd(plan.estimateUsd)}` }),
    t('writing.draft.confirm_cap', { cap: usd(plan.capUsd) }),
    plan.monthCapUsd === null ? t('writing.draft.confirm_month_no_cap', { spent: usd(plan.monthSpentUsd) }) : t('writing.draft.confirm_month', { spent: usd(plan.monthSpentUsd), cap: usd(plan.monthCapUsd) })
  ]
}

/** A draft's title in the list; a copy the sync split off says which machine it came from. */
export function draftTitle(t: TFunction, s: Pick<DraftSummary, 'title' | 'copyOf'>): string {
  if (!s.copyOf) return s.title
  return t('writing.draft.copy_title', { title: s.title, machine: s.copyOf.machine ?? t('chat.other_machine') })
}

/** The chosen papers, each once, in order; `over` when there are more than a draft may use. */
export function draftPapers(ids: readonly string[]): { papers: string[]; over: boolean } {
  const papers = [...new Set(ids)]
  return { papers, over: papers.length > MAX_DRAFT_PAPERS }
}

/** «Guardar…»'s file name: the draft's title in the chosen format's extension. */
export function draftFileName(title: string, format: CiteFormat): string {
  return exportFileName(title, FILE_EXTENSIONS[format])
}
