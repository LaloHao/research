/** «Borrador»: a section Claude drafts from chosen papers, kept in drafts/<id>.md with its earlier versions. */
import { z } from 'zod'
import { CHAT_ID, MESSAGE_AT, MESSAGE_MODEL, PAPER_KEY, type ChatCitation, type ChatStreamEvent } from '../chat'
import { LLM_MODELS, type LlmModel } from '../summary'
import { convertMarkers, type ConvertOptions, type ConvertResult } from './convert'

/** `<UTC yyyymmdd>-<hhmmss>-<4 hex>`, plus `-<6 hex>` for each copy the git sync split off (the chats' ids). */
export const DRAFT_ID = CHAT_ID
export const MAX_DRAFT_TITLE = 120
export const MAX_DRAFT_PURPOSE = 4_000
/** The papers one draft may be written from (each goes into the prompt with its one-liner). */
export const MAX_DRAFT_PAPERS = 60
/** The longest text a version may hold (an edit beyond it is refused). */
export const MAX_DRAFT_TEXT = 100_000

export const DRAFT_LENGTHS = ['short', 'medium', 'long'] as const
export type DraftLength = (typeof DRAFT_LENGTHS)[number]
/** About how many words each length asks for. */
export const DRAFT_WORDS: Record<DraftLength, number> = { short: 300, medium: 700, long: 1500 }

/**
 * What the model writes after a claim the chosen papers do not support (instead of a citation). Counted and shown; on
 * export it becomes a visible `[SIN CITA]` (an Org link or a Markdown reference would hide it).
 */
export const UNCITED_MARK = '[[sin cita]]'
export const UNCITED_EXPORT = '[SIN CITA]'

const RQ_ID = /^RQ[1-9][0-9]*$/

/** One version's heading data; its text is the body section of the same number. */
export const DraftVersionSchema = z.object({
  at: z.string().regex(MESSAGE_AT),
  /** The model id that wrote it (from the CLI's usage), `unknown` when it is not known. */
  model: z.string().regex(MESSAGE_MODEL),
  cost_usd: z.number().min(0).lt(1e9),
  /** «Detener»: the text is what had arrived. */
  stopped: z.boolean().default(false),
  /** The last time the user edited its text in the app. */
  edited_at: z.string().regex(MESSAGE_AT).optional()
})
export type DraftVersion = z.infer<typeof DraftVersionSchema>

/** Frontmatter of drafts/<id>.md. Loose: keys added by a later version survive a round trip and the sync's merge. */
export const DraftMetaSchema = z.looseObject({
  schema_version: z.literal(1),
  id: z.string().regex(DRAFT_ID),
  title: z.string().min(1).max(MAX_DRAFT_TITLE),
  purpose: z.string().max(MAX_DRAFT_PURPOSE).default(''),
  /** A research question of Ajustes → Tesis (its id), or null. */
  rq: z.string().regex(RQ_ID).nullable().default(null),
  papers: z.array(z.string().regex(PAPER_KEY)).max(MAX_DRAFT_PAPERS).default([]),
  length: z.enum(DRAFT_LENGTHS).default('medium'),
  /** The model for the next version. */
  model: z.enum(LLM_MODELS),
  created_at: z.string(),
  updated_at: z.string(),
  archived: z.boolean().default(false),
  /** Sum of the versions' costs (recomputed on every write). */
  cost_usd: z.number().min(0).default(0),
  /** Oldest first; the last one is the current text. */
  versions: z.array(DraftVersionSchema).default([]),
  /** The machine that wrote the file last; names the copy when the sync has to split the draft. */
  updated_on: z.string().optional(),
  /** Only on a draft the sync split off: the original's id and the machine this version came from. */
  copy_of: z.object({ id: z.string().regex(DRAFT_ID), machine: z.string().nullable() }).optional()
})
export type DraftMeta = z.infer<typeof DraftMetaSchema>

export interface DraftFile {
  meta: DraftMeta
  /** The text of each version, in the order of `meta.versions`. */
  texts: string[]
}

/** The form of «Borrador»: what the next version is written from. */
export interface DraftInput {
  title: string
  purpose: string
  rq: string | null
  papers: string[]
  length: DraftLength
  model: LlmModel
}

export interface DraftSummary {
  id: string
  title: string
  archived: boolean
  updatedAt: string
  costUsd: number
  versions: number
  papers: number
  /** A copy the sync split off, and the machine its version came from («(copia de <equipo>)»). */
  copyOf: { machine: string | null } | null
  /** The file cannot be read (git conflict markers, invalid frontmatter): it can only be deleted or fixed by hand. */
  problem: boolean
}

/** A citation as the chat checks it, plus whether it cites a paper outside the draft's selection. */
export type DraftCitation = ChatCitation & { outside: boolean }

export interface DraftCheck {
  citations: DraftCitation[]
  /** Citations not found in the paper's text (or of a paper in the trash or unknown). */
  unverified: number
  /** Citations of papers outside the selection («fuera de la selección»). */
  outside: number
  /** Claims the model marked as unsupported (`[[sin cita]]`). */
  uncited: number
}

export interface DraftVersionView {
  at: string
  model: string
  costUsd: number
  stopped: boolean
  editedAt: string | null
  text: string
  check: DraftCheck
}

/** The version being written right now; `seq` orders it against the stream updates. */
export interface DraftPartial {
  text: string
  tools: number
  seq: number
}

export interface DraftView {
  summary: DraftSummary
  input: DraftInput
  versions: DraftVersionView[]
  partial: DraftPartial | null
}

export interface DraftListQuery {
  /** Words in the title, the purpose or the current text (case, accents and whitespace ignored). */
  text?: string
}

export type DraftStreamEvent = Exclude<ChatStreamEvent, { kind: 'approvals' }>
/** Pushed on DRAFT_STREAM_CHANNEL; `seq` grows across every run of the session. */
export type DraftStreamUpdate = DraftStreamEvent & { draftId: string; seq: number }

export type DraftOpenResult = { ok: true; draft: DraftView } | { ok: false; error: string }
export type DraftRunResult = { ok: true; draftId: string } | { ok: false; error: string }
export type DraftEditResult = { ok: true; check: DraftCheck } | { ok: false; error: string }

/** How many `[[sin cita]]` marks a text has. */
export function uncitedCount(text: string): number {
  return text.split(UNCITED_MARK).length - 1
}

/** The chat's check of each citation, each flagged when it cites a paper outside `papers`, and the counts. */
export function draftCheck(text: string, citations: ChatCitation[], papers: readonly string[]): DraftCheck {
  const chosen = new Set(papers)
  const flagged = citations.map((c) => ({ ...c, outside: !chosen.has(c.paper) }))
  return {
    citations: flagged,
    unverified: flagged.filter((c) => c.state !== 'found').length,
    outside: flagged.filter((c) => c.outside).length,
    uncited: uncitedCount(text)
  }
}

/**
 * A version as Org, LaTeX or Markdown: its markers converted with the app's check of each (an unverified one keeps its
 * «NO VERIFICADA» note and is counted), and each `[[sin cita]]` made a visible `[SIN CITA]`.
 */
export function exportDraft(text: string, check: DraftCheck, opts: Omit<ConvertOptions, 'checks'>): ConvertResult {
  return convertMarkers(text.split(UNCITED_MARK).join(UNCITED_EXPORT), { ...opts, checks: check.citations })
}
