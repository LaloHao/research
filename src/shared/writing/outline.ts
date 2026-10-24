/**
 * «Esquema» (basic, without Claude): the papers grouped by the values of a main facet, and of an optional secondary
 * one, with the gaps (values and combinations without papers), exported as LaTeX, Markdown or Org. Pure.
 */
import type { RelationType } from '../typedRelations'
import type { CiteFormat } from './citations'
import { commentLine, escapeLatex, formatCitation } from './convert'

export interface OutlinePaper {
  id: string
  title: string
  year: number | null
  /** The summary's one-liner («en pocas palabras»), when there is one. */
  tldr: string | null
  /** Each single/multi facet's values; `reviewed`: the entry is verified or edited. */
  facets: Record<string, { values: string[]; reviewed: boolean }>
}

export interface OutlineFacet {
  key: string
  /** The form's values, in the form's order. */
  values: string[]
}

export interface OutlineRelation {
  from: string
  to: string
  type: RelationType
}

export interface OutlineInput {
  papers: OutlinePaper[]
  facet: OutlineFacet
  secondary?: OutlineFacet | null
  /** Confirmed typed relations; only those between two papers of the set are kept. */
  relations: OutlineRelation[]
  /** Count only facet entries the user verified or edited. */
  onlyReviewed: boolean
  question?: { id: string; text: string } | null
}

export interface OutlineEntry {
  id: string
  title: string
  year: number | null
  tldr: string | null
  /** The paper's confirmed relations with other papers of the set, as stored (`from` → `to`). */
  relations: OutlineRelation[]
}

export interface OutlineGroup {
  value: string
  papers: OutlineEntry[]
}

export interface OutlineSection extends OutlineGroup {
  /** By the secondary facet; `papers` then holds the section's papers without a secondary value. */
  subsections: OutlineGroup[]
}

export interface Outline {
  facet: string
  secondary: string | null
  question: { id: string; text: string } | null
  /** Every value of the main facet in order: the form's, then any others papers still have. */
  values: string[]
  sections: OutlineSection[]
  /** Papers without a (counted) value of the main facet. */
  unclassified: OutlineEntry[]
  gaps: {
    /** Main facet values without papers. */
    values: string[]
    /** Main × secondary combinations without papers, for main values that have some. */
    combinations: { value: string; secondary: string }[]
  }
}

function valuesOf(paper: OutlinePaper, facet: string, onlyReviewed: boolean): string[] {
  const entry = paper.facets[facet]
  if (!entry || (onlyReviewed && !entry.reviewed)) return []
  return [...new Set(entry.values)]
}

/** The form's values first, then any value papers still have that the form no longer lists. */
function orderedValues(facet: OutlineFacet, used: Iterable<string>): string[] {
  const extra = [...new Set(used)].filter((v) => !facet.values.includes(v)).sort()
  return [...facet.values, ...extra]
}

const byYear = (a: OutlineEntry, b: OutlineEntry): number => (a.year ?? 9999) - (b.year ?? 9999) || a.id.localeCompare(b.id)

export function buildOutline(input: OutlineInput): Outline {
  const ids = new Set(input.papers.map((p) => p.id))
  const relations = input.relations.filter((r) => ids.has(r.from) && ids.has(r.to) && r.from !== r.to)
  const entry = (p: OutlinePaper): OutlineEntry => ({
    id: p.id,
    title: p.title,
    year: p.year,
    tldr: p.tldr,
    relations: relations.filter((r) => r.from === p.id || r.to === p.id)
  })
  const secondary = input.secondary && input.secondary.key !== input.facet.key ? input.secondary : null
  const main = new Map<string, OutlinePaper[]>()
  const unclassified: OutlineEntry[] = []
  for (const p of input.papers) {
    const values = valuesOf(p, input.facet.key, input.onlyReviewed)
    if (values.length === 0) unclassified.push(entry(p))
    for (const v of values) main.set(v, [...(main.get(v) ?? []), p])
  }
  const sections: OutlineSection[] = []
  const gaps: Outline['gaps'] = { values: [], combinations: [] }
  const values = orderedValues(input.facet, main.keys())
  for (const value of values) {
    const papers = main.get(value)
    if (!papers) {
      gaps.values.push(value)
      continue
    }
    if (!secondary) {
      sections.push({ value, papers: papers.map(entry).sort(byYear), subsections: [] })
      continue
    }
    const sub = new Map<string, OutlinePaper[]>()
    const withoutSecondary: OutlineEntry[] = []
    for (const p of papers) {
      const values = valuesOf(p, secondary.key, input.onlyReviewed)
      if (values.length === 0) withoutSecondary.push(entry(p))
      for (const v of values) sub.set(v, [...(sub.get(v) ?? []), p])
    }
    const subsections: OutlineGroup[] = []
    for (const s of orderedValues(secondary, sub.keys())) {
      const inSub = sub.get(s)
      if (inSub) subsections.push({ value: s, papers: inSub.map(entry).sort(byYear) })
      else gaps.combinations.push({ value, secondary: s })
    }
    sections.push({ value, papers: withoutSecondary.sort(byYear), subsections })
  }
  return {
    facet: input.facet.key,
    secondary: secondary?.key ?? null,
    question: input.question ?? null,
    values,
    sections,
    unclassified: unclassified.sort(byYear),
    gaps
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Export

/** The words the export writes (the renderer passes the UI's; a later API may pass its own). */
export interface OutlineLabels {
  /** A facet value as a heading (`log_parsing` → `log parsing` by default). */
  value: (facet: string, value: string) => string
  unclassified: string
  /** `<value>` (already through `value`) without papers. */
  gapValue: (value: string) => string
  /** `<value>` × `<secondary>` without papers. */
  gapCombination: (value: string, secondary: string) => string
  /** A relation between two citations already written in the output syntax. */
  relation: (type: RelationType, from: string, to: string) => string
  /** The header comment: facets and the research question. */
  header: (facet: string, secondary: string | null, question: { id: string; text: string } | null) => string
}

export const DEFAULT_OUTLINE_LABELS: OutlineLabels = {
  value: (_facet, value) => value.replace(/_/g, ' '),
  unclassified: 'Unclassified',
  gapValue: (value) => `${value}: no papers`,
  gapCombination: (value, secondary) => `${value} × ${secondary}: no papers`,
  relation: (type, from, to) => `${from} ${type.replace(/_/g, ' ')} ${to}`,
  header: (facet, secondary, question) =>
    `Outline by ${facet}${secondary ? ` / ${secondary}` : ''}${question ? `; research question ${question.id}: ${question.text}` : ''}`
}

/**
 * What «Proponer redacción del esquema» adds to the export: its order of the main values, its headings, and paragraphs
 * already written in the output format (citations converted, LaTeX escaped) after a heading or a gap.
 */
export interface OutlineDecorations {
  /** Main values in the order to write them; values it leaves out keep their relative order after them. */
  order?: string[]
  /** A heading instead of the value's label (`sub`: the secondary value of a subsection; `value` null: «Sin clasificar»); plain text. */
  title?: (value: string | null, sub: string | null) => string | null
  /** The paragraph after a heading (`value` null: «Sin clasificar»). */
  opening?: (value: string | null, sub: string | null) => string | null
  /** The paragraph after a gap's comment (`secondary` null: a main value without papers). */
  gapNote?: (value: string, secondary: string | null) => string | null
}

export interface OutlineExportOptions {
  format: CiteFormat
  labels?: OutlineLabels
  decorations?: OutlineDecorations
}

/** The outline as headings (`\section`/`\subsection`, `#`/`##`, `*`/`**`), one item per paper and the gaps as comments. */
export function renderOutline(outline: Outline, opts: OutlineExportOptions): string {
  const labels = opts.labels ?? DEFAULT_OUTLINE_LABELS
  const { format } = opts
  const deco = opts.decorations ?? {}
  const paragraph = (p: string | null | undefined): string[] => (p && p.trim() ? ['', p.trim(), ''] : [])
  const text = (s: string): string => (format === 'latex' ? escapeLatex(s) : s.replace(/\s+/g, ' ').trim())
  const cite = (key: string): string => formatCitation({ key, page: null }, format)
  const gap = (s: string): string => commentLine(`HUECO: ${s}`, format)
  const heading = (level: 1 | 2, title: string): string => {
    if (format === 'latex') return `${level === 1 ? '\\section' : '\\subsection'}{${text(title)}}`
    if (format === 'markdown') return `${level === 1 ? '#' : '##'} ${text(title)}`
    return `${level === 1 ? '*' : '**'} ${text(title)}`
  }
  const item = (e: OutlineEntry): string => {
    const parts = [`${cite(e.id)} ${text(e.title)}${e.year !== null ? ` (${e.year})` : ''}.`]
    if (e.tldr) parts.push(text(e.tldr))
    if (e.relations.length > 0) parts.push(`${e.relations.map((r) => labels.relation(r.type, cite(r.from), cite(r.to))).join('; ')}.`)
    return `${format === 'latex' ? '  \\item' : '-'} ${parts.join(' ')}`
  }
  const list = (entries: OutlineEntry[]): string[] => {
    if (entries.length === 0) return []
    const items = entries.map(item)
    return format === 'latex' ? ['\\begin{itemize}', ...items, '\\end{itemize}'] : items
  }
  const blocks: string[] = [commentLine(labels.header(outline.facet, outline.secondary, outline.question), format)]
  // Sections in the order of the facet's values (or the decorations'), the empty ones as gaps where their section would be.
  const sectionsByValue = new Map(outline.sections.map((s) => [s.value, s]))
  const order = deco.order ? [...new Set(deco.order.filter((v) => outline.values.includes(v)))] : []
  for (const value of [...order, ...outline.values.filter((v) => !order.includes(v))]) {
    const section = sectionsByValue.get(value)
    if (!section) {
      blocks.push([gap(labels.gapValue(labels.value(outline.facet, value))), ...paragraph(deco.gapNote?.(value, null))].join('\n').trimEnd())
      continue
    }
    const lines = [heading(1, deco.title?.(value, null) || labels.value(outline.facet, value)), ...paragraph(deco.opening?.(value, null)), ...list(section.papers)]
    for (const sub of section.subsections) {
      lines.push('', heading(2, deco.title?.(value, sub.value) || labels.value(outline.secondary!, sub.value)), ...paragraph(deco.opening?.(value, sub.value)), ...list(sub.papers))
    }
    for (const c of outline.gaps.combinations.filter((c) => c.value === value)) {
      lines.push(gap(labels.gapCombination(labels.value(outline.facet, c.value), labels.value(outline.secondary!, c.secondary))), ...paragraph(deco.gapNote?.(c.value, c.secondary)))
    }
    blocks.push(lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd())
  }
  if (outline.unclassified.length > 0) {
    blocks.push([heading(1, deco.title?.(null, null) || labels.unclassified), ...paragraph(deco.opening?.(null, null)), ...list(outline.unclassified)].join('\n').trimEnd())
  }
  return `${blocks.join('\n\n')}\n`
}
