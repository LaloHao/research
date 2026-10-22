/**
 * «Proponer redacción del esquema»: Claude proposes headings, the order of the sections, an opening sentence per section
 * and a sentence per gap on why it matters for the thesis, over the outline the app built. Pure: the ids Claude answers
 * with, the strict check of its answer, and the export through `renderOutline` and `convertMarkers`.
 *
 * Ids: `S1`, `S2`… the sections in the outline's order, `S1.1`… their subsections, `U` «Sin clasificar», `G1`, `G2`…
 * the gaps (main values first, then combinations). Claude may only name these ids and cite the outline's papers with
 * the app's markers (`[[key|p. N|"quote"]]`); anything else makes the answer invalid. Sections it leaves out keep
 * their heading and get no opening; main ids it leaves out of `order` keep their relative order after the ones it
 * lists. «Sin clasificar» always goes last.
 */
import { z } from 'zod'
import type { ChatCitation } from '../chat'
import type { LlmModel } from '../summary'
import type { OutlineScope } from './api'
import { parseCitations as parseMarkers } from '../chatCitations'
import type { CiteFormat } from './citations'
import { convertMarkers, type LatexOutputCommand, type MarkerCheck } from './convert'
import { renderOutline, type Outline, type OutlineDecorations, type OutlineLabels } from './outline'

export const MAX_TITLE_CHARS = 200
export const MAX_OPENING_CHARS = 1500
export const MAX_GAP_NOTE_CHARS = 1000
/** The most papers an outline sent to Claude may have (its input stays bounded). */
export const MAX_PROPOSAL_PAPERS = 300

export interface OutlineTarget {
  id: string
  kind: 'section' | 'subsection' | 'unclassified'
  /** The main value (null for «Sin clasificar»). */
  value: string | null
  /** The secondary value of a subsection. */
  sub: string | null
  /** The papers listed under it (not those of its subsections). */
  papers: string[]
}

export interface OutlineGapTarget {
  id: string
  value: string
  secondary: string | null
}

export interface OutlineTargets {
  sections: OutlineTarget[]
  gaps: OutlineGapTarget[]
  /** The main ids (sections and gaps of main values) in the outline's order: what `order` may list. */
  top: string[]
  /** Every paper of the outline. */
  papers: Set<string>
}

/** The ids Claude answers with, for an outline. */
export function outlineTargets(outline: Outline): OutlineTargets {
  const sections: OutlineTarget[] = []
  const gaps: OutlineGapTarget[] = []
  const top: string[] = []
  const papers = new Set<string>()
  const byValue = new Map(outline.sections.map((s) => [s.value, s]))
  const valueGap = new Map(outline.gaps.values.map((v, i) => [v, `G${i + 1}`]))
  outline.gaps.values.forEach((value) => gaps.push({ id: valueGap.get(value)!, value, secondary: null }))
  outline.gaps.combinations.forEach((c, i) => gaps.push({ id: `G${outline.gaps.values.length + i + 1}`, value: c.value, secondary: c.secondary }))
  let n = 0
  for (const value of outline.values) {
    const section = byValue.get(value)
    if (!section) {
      const gap = valueGap.get(value)
      if (gap) top.push(gap)
      continue
    }
    const id = `S${++n}`
    top.push(id)
    sections.push({ id, kind: 'section', value, sub: null, papers: section.papers.map((p) => p.id) })
    section.subsections.forEach((sub, i) => sections.push({ id: `${id}.${i + 1}`, kind: 'subsection', value, sub: sub.value, papers: sub.papers.map((p) => p.id) }))
  }
  if (outline.unclassified.length > 0) sections.push({ id: 'U', kind: 'unclassified', value: null, sub: null, papers: outline.unclassified.map((p) => p.id) })
  for (const s of outline.sections) {
    for (const p of s.papers) papers.add(p.id)
    for (const sub of s.subsections) for (const p of sub.papers) papers.add(p.id)
  }
  for (const p of outline.unclassified) papers.add(p.id)
  return { sections, gaps, top, papers }
}

/** The outline to propose for, as «Esquema» builds it: the main process builds it again from the library. */
export interface OutlineRequest {
  scope: OutlineScope
  facet: string
  secondary: string | null
  onlyReviewed: boolean
  questionId: string | null
  model?: LlmModel
}

/** A proposal with the outline it is for and the app's check of each text's markers (by section or gap id). */
export interface OutlineProposalRun {
  outline: Outline
  proposal: OutlineProposal
  checks: Record<string, ChatCitation[]>
  costUsd: number
  model: string
}
export type OutlineProposalResult = { ok: true; run: OutlineProposalRun } | { ok: false; error: string }

export interface OutlineProposal {
  /** Every main id, in the proposed order. */
  order: string[]
  /** By section id; only the sections Claude wrote. */
  sections: Record<string, { title: string; opening: string }>
  /** By gap id. */
  gaps: Record<string, string>
}

// ---------------------------------------------------------------------------------------------------------------------
// Claude's answer

const outputSchema = z.strictObject({
  order: z.array(z.string()).max(500),
  sections: z
    .array(z.strictObject({ id: z.string(), title: z.string().trim().min(1).max(MAX_TITLE_CHARS), opening: z.string().trim().max(MAX_OPENING_CHARS) }))
    .max(1000),
  gaps: z.array(z.strictObject({ id: z.string(), note: z.string().trim().min(1).max(MAX_GAP_NOTE_CHARS) })).max(1000)
})

/** The JSON Schema of the answer (--json-schema). */
export function outlineProposalSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['order', 'sections', 'gaps'],
    properties: {
      order: { type: 'array', items: { type: 'string' } },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'opening'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string', minLength: 1, maxLength: MAX_TITLE_CHARS },
            opening: { type: 'string', maxLength: MAX_OPENING_CHARS }
          }
        }
      },
      gaps: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'note'],
          properties: { id: { type: 'string' }, note: { type: 'string', minLength: 1, maxLength: MAX_GAP_NOTE_CHARS } }
        }
      }
    }
  }
}

/** Why a text of the answer is unusable: a `[[` that is not a well-formed marker, or a marker citing a paper outside the outline. */
function markerProblem(text: string, papers: Set<string>): string | null {
  const markers = parseMarkers(text)
  const opens = text.split('[[').length - 1
  if (opens !== markers.length) return 'a citation marker is malformed'
  const outside = markers.find((m) => !papers.has(m.paper))
  return outside ? `cites ${outside.paper}, which is not in the outline` : null
}

/**
 * Claude's answer, strictly: only the outline's ids, each once; titles plain text (no markers, no line breaks);
 * openings and gap notes cite only the outline's papers, with well-formed markers.
 */
export function parseOutlineProposal(raw: unknown, targets: OutlineTargets): { ok: true; proposal: OutlineProposal } | { ok: false; error: string } {
  const parsed = outputSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) }
  const out = parsed.data
  const sectionIds = new Set(targets.sections.map((s) => s.id))
  const gapIds = new Set(targets.gaps.map((g) => g.id))
  const top = new Set(targets.top)
  const fail = (error: string) => ({ ok: false as const, error })
  const seenOrder = new Set<string>()
  for (const id of out.order) {
    if (!top.has(id)) return fail(`order: ${id} is not a main section or gap id`)
    if (seenOrder.has(id)) return fail(`order: ${id} is repeated`)
    seenOrder.add(id)
  }
  const sections: OutlineProposal['sections'] = {}
  for (const s of out.sections) {
    if (!sectionIds.has(s.id)) return fail(`sections: ${s.id} is not a section id`)
    if (sections[s.id]) return fail(`sections: ${s.id} is repeated`)
    if (/[\n\r]/.test(s.title) || s.title.includes('[[')) return fail(`sections: ${s.id}: the title must be plain text on one line`)
    const problem = markerProblem(s.opening, targets.papers)
    if (problem) return fail(`sections: ${s.id}: ${problem}`)
    sections[s.id] = { title: s.title, opening: s.opening }
  }
  const gaps: OutlineProposal['gaps'] = {}
  for (const g of out.gaps) {
    if (!gapIds.has(g.id)) return fail(`gaps: ${g.id} is not a gap id`)
    if (gaps[g.id] !== undefined) return fail(`gaps: ${g.id} is repeated`)
    const problem = markerProblem(g.note, targets.papers)
    if (problem) return fail(`gaps: ${g.id}: ${problem}`)
    gaps[g.id] = g.note
  }
  return { ok: true, proposal: { order: [...out.order, ...targets.top.filter((id) => !seenOrder.has(id))], sections, gaps } }
}

/** The texts with markers, by id (section openings and gap notes), as the app checks them. */
export function proposalTexts(proposal: OutlineProposal): { id: string; text: string }[] {
  return [
    ...Object.entries(proposal.sections).map(([id, s]) => ({ id, text: s.opening })),
    ...Object.entries(proposal.gaps).map(([id, text]) => ({ id, text }))
  ].filter((t) => t.text.length > 0)
}

// ---------------------------------------------------------------------------------------------------------------------
// Export

export interface ProposalExportOptions {
  format: CiteFormat
  labels?: OutlineLabels
  latexCommand?: LatexOutputCommand
  /** Keep each verbatim quote as a comment. */
  quotes?: boolean
  /** The app's check of each text's markers, by section or gap id, in marker order. */
  checks?: Record<string, readonly (MarkerCheck | null | undefined)[]>
}

/** The outline with the proposal merged in, in the output format; `unverified` counts the citations that did not check out. */
export function renderProposedOutline(
  outline: Outline,
  proposal: OutlineProposal,
  opts: ProposalExportOptions
): { text: string; converted: number; unverified: number } {
  const targets = outlineTargets(outline)
  const sectionId = new Map(targets.sections.map((s) => [`${s.value ?? ''}\u0000${s.sub ?? ''}`, s.id]))
  const gapId = new Map(targets.gaps.map((g) => [`${g.value}\u0000${g.secondary ?? ''}`, g.id]))
  const topValue = new Map<string, string>([
    ...targets.sections.filter((s) => s.kind === 'section').map((s): [string, string] => [s.id, s.value!]),
    ...targets.gaps.filter((g) => g.secondary === null).map((g): [string, string] => [g.id, g.value])
  ])
  let converted = 0
  let unverified = 0
  const convert = (id: string | undefined, text: string | undefined): string | null => {
    if (!id || !text || !text.trim()) return null
    const r = convertMarkers(text.trim(), { format: opts.format, latexCommand: opts.latexCommand, quotes: opts.quotes, checks: opts.checks?.[id] })
    converted += r.converted
    unverified += r.unverified
    return r.text
  }
  const decorations: OutlineDecorations = {
    order: proposal.order.flatMap((id) => (topValue.has(id) ? [topValue.get(id)!] : [])),
    title: (value, sub) => proposal.sections[sectionId.get(`${value ?? ''}\u0000${sub ?? ''}`) ?? '']?.title ?? null,
    opening: (value, sub) => {
      const id = sectionId.get(`${value ?? ''}\u0000${sub ?? ''}`)
      return convert(id, id ? proposal.sections[id]?.opening : undefined)
    },
    gapNote: (value, secondary) => {
      const id = gapId.get(`${value}\u0000${secondary ?? ''}`)
      return convert(id, id ? proposal.gaps[id] : undefined)
    }
  }
  const text = renderOutline(outline, { format: opts.format, labels: opts.labels, decorations })
  return { text, converted, unverified }
}
