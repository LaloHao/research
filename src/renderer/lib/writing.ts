import type { TFunction } from 'i18next'
import type { WritingLibrary, WritingPlanKind, WritingRunPlan } from '../../shared/writing/api'
import { CITE_FORMATS, type CiteFormat, type KeyIndex } from '../../shared/writing/citations'
import { LATEX_OUTPUT_COMMANDS, type LatexOutputCommand } from '../../shared/writing/convert'
import { approxUsd } from './mappings'

/** «Redacción»'s output choice, remembered per project in this window's storage. */
export interface WritingPrefs {
  format: CiteFormat
  latexCommand: LatexOutputCommand
}

export const DEFAULT_WRITING_PREFS: WritingPrefs = { format: 'org', latexCommand: 'cite' }

const prefsKey = (projectRoot: string): string => `writing-prefs:${projectRoot}`

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

/** The project's remembered choice; the defaults when there is none, it is invalid or storage is unavailable. */
export function loadWritingPrefs(projectRoot: string, storage: Storage | null = globalThis.localStorage ?? null): WritingPrefs {
  try {
    const raw = JSON.parse(storage?.getItem(prefsKey(projectRoot)) ?? 'null') as Partial<WritingPrefs> | null
    return {
      format: CITE_FORMATS.includes(raw?.format as CiteFormat) ? (raw!.format as CiteFormat) : DEFAULT_WRITING_PREFS.format,
      latexCommand: LATEX_OUTPUT_COMMANDS.includes(raw?.latexCommand as LatexOutputCommand) ? (raw!.latexCommand as LatexOutputCommand) : DEFAULT_WRITING_PREFS.latexCommand
    }
  } catch {
    return { ...DEFAULT_WRITING_PREFS }
  }
}

export function saveWritingPrefs(projectRoot: string, prefs: WritingPrefs, storage: Storage | null = globalThis.localStorage ?? null): void {
  try {
    storage?.setItem(prefsKey(projectRoot), JSON.stringify(prefs))
  } catch {
    // Storage unavailable (private window, quota): the choice lasts for this session only.
  }
}

export function keyIndexOf(library: WritingLibrary): KeyIndex {
  return { papers: new Map(library.papers.map((p) => [p.id, { hasText: p.hasText }])), trashed: new Set(library.trashed.map((t) => t.id)) }
}

export const FILE_EXTENSIONS: Record<CiteFormat, string> = { latex: 'tex', markdown: 'md', org: 'org' }

/** A bare file name the save dialog accepts (`[\w.-]`, at most 100 characters) from a chosen file's name. */
export function exportFileName(base: string, extension: string): string {
  const stem = base.replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80)
  return `${stem || 'export'}.${extension}`
}

/** A Claude operation's confirmation lines: its estimate, its own cap and the month's spending. */
export function writingPlanLines(t: TFunction, kind: WritingPlanKind, plan: WritingRunPlan): string[] {
  return [
    t('writing.claude.estimate', { cost: approxUsd(plan.estimateUsd) }),
    t(`writing.claude.cap_${kind}`, { cap: plan.capUsd.toFixed(2) }),
    plan.monthCapUsd === null
      ? t('writing.claude.month_no_cap', { spent: plan.monthSpentUsd.toFixed(2) })
      : t('writing.claude.month', { spent: plan.monthSpentUsd.toFixed(2), cap: plan.monthCapUsd.toFixed(2) })
  ]
}
