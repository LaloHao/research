import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import { z } from 'zod'
import { PAPER_KEY } from '../../shared/chat'
import { MAX_BIB_TEXT_CHARS, type OutlineScope } from '../../shared/writing/api'
import { BIB_ORDERS, chapterBibText, type ChapterBibReport } from '../../shared/writing/bibtex'
import { CITE_FORMATS, detectFormat, parseCitations, resolveCitations, type CiteFormat } from '../../shared/writing/citations'
import { buildOutline, renderOutline, type OutlineLabels } from '../../shared/writing/outline'
import es from '../../renderer/i18n/es.json'
import { UserFacingError } from '../library/UserFacingError'
import { foldQuery } from '../mcp/libraryTools'
import { ApiError, freeTool, type ApiContext, type ApiTool } from './registry'

export const format = z.enum(CITE_FORMATS)
const text = z.string().max(MAX_BIB_TEXT_CHARS)
const key = z.string().regex(PAPER_KEY).max(80).describe('Citation key of a library paper, e.g. he2017drain')
/** The files `bibtex_for_file` accepts, as the app's own dialog does (and what `formatOfPath` reads). */
const SOURCE_EXTENSIONS = new Set(['.tex', '.ltx', '.org', '.md', '.markdown', '.qmd', '.rmd'])
const MAX_PASSAGES = 30

/**
 * Offsets in code points: an editor (Emacs) counts characters, JavaScript counts UTF-16 units, and the two differ after
 * any character outside the BMP (an emoji, some math letters).
 */
export function codePointOffsets(text: string): (index: number) => number {
  if (!/[\uD800-\uDFFF]/.test(text)) return (i) => i
  const map = new Int32Array(text.length + 1)
  let cp = 0
  for (let i = 0; i < text.length; i++) {
    map[i] = cp
    const c = text.charCodeAt(i)
    // The low half of a pair belongs to the code point the high half started.
    if (!(c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00)) cp++
  }
  map[text.length] = cp
  return (i) => map[Math.max(0, Math.min(i, text.length))]
}

const bibReport = (report: ChapterBibReport) => ({
  keys: report.keys,
  entries: report.entries.map((e) => e.key),
  unknown: report.unknown,
  trashed: report.trashed,
  incomplete: report.incomplete,
  invalid: report.invalid
})

function requirePaper(ctx: ApiContext, id: string) {
  const row = PAPER_KEY.test(id) ? ctx.cache.getPaper(id) : null
  if (!row || row.problem) throw new ApiError('not_found', `No library paper has the key "${id.slice(0, 80)}".`)
  return row
}

/** A file error of `readWithIncludes`, as the API's codes. */
function fileError(error: unknown): never {
  if (error instanceof UserFacingError && error.code === 'writing_file_too_large') throw new ApiError('too_large', 'The file (or what it includes) is too large.')
  if (error instanceof UserFacingError) throw new ApiError('unreadable', 'The file could not be read.')
  throw error
}

/** The app's own words for the outline export (the UI's Spanish strings), so both export the same text. */
const interpolate = (template: string, values: Record<string, string>): string => template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => values[name] ?? '')
const OUTLINE = es.writing.outline
export const OUTLINE_LABELS: OutlineLabels = {
  value: (_facet, value) => value.replace(/_/g, ' '),
  unclassified: OUTLINE.unclassified,
  gapValue: (value) => interpolate(OUTLINE.gap_value, { value }),
  gapCombination: (value, other) => interpolate(OUTLINE.gap_combination, { value, other }),
  relation: (type, from, to) => interpolate(es.typed.sentence[type], { from, to }),
  header: (facet, secondary, q) =>
    [
      interpolate(OUTLINE.header, { facet }),
      secondary ? interpolate(OUTLINE.header_secondary, { facet: secondary }) : '',
      q ? interpolate(OUTLINE.header_question, { id: q.id, text: q.text }) : ''
    ]
      .filter(Boolean)
      .join('; ')
}

/**
 * The sentence of a search hit that holds most of the query's words (case and accents ignored): what an editor inserts
 * as the quote. Falls back to the whole snippet when it has no sentence break.
 */
export function bestSentence(snippet: string, query: string): string {
  const words = (foldQuery(query).match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1)
  const sentences = snippet
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=\p{Lu}|\d|["“(])/u)
    .map((s) => s.trim())
    .filter(Boolean)
  let best = sentences[0] ?? snippet.trim()
  let score = -1
  for (const s of sentences) {
    const folded = foldQuery(s)
    const n = words.filter((w) => folded.includes(w)).length
    if (n > score) {
      score = n
      best = s
    }
  }
  return best
}

/** The outline's choices, shared by `outline` and the costly `outline_proposal`. */
export const OUTLINE_INPUT = {
  scope: z.enum(['library', 'mapping', 'papers']).optional().describe('library (default), a mapping\'s included papers, or the given papers'),
  mapping_id: z.string().max(80).optional(),
  paper_ids: z.array(key).max(5000).optional(),
  rq: z.string().regex(/^RQ[1-9][0-9]*$/).optional().describe('A research question of the thesis, e.g. RQ1'),
  facet: z.string().max(80).optional().describe('Main facet key; the form\'s first one when missing'),
  secondary: z.string().max(80).optional().describe('Secondary facet key'),
  reviewed_only: z.boolean().optional().describe('Count only facet values the user verified or edited'),
  format: format.optional().describe('org (default), latex or markdown')
}
type OutlineArgs = z.infer<z.ZodObject<typeof OUTLINE_INPUT>>

/** The scope, facets and question the arguments name, checked against the form and the thesis. */
export async function outlineChoice(ctx: ApiContext, args: OutlineArgs) {
  const scope: OutlineScope =
    args.scope === 'mapping'
      ? { kind: 'mapping', mappingId: args.mapping_id ?? '' }
      : args.scope === 'papers'
        ? { kind: 'papers', ids: args.paper_ids ?? [] }
        : { kind: 'library' }
  const data = await ctx.writing.outlineData(scope)
  if (data.facets.length === 0) throw new ApiError('no_facets', 'The extraction form has no single or multi facets to group by.')
  const main = args.facet === undefined ? data.facets[0] : data.facets.find((f) => f.key === args.facet)
  if (!main) throw new ApiError('not_found', `The form has no facet "${args.facet}". Facets: ${data.facets.map((f) => f.key).join(', ')}.`)
  const secondary = args.secondary === undefined ? null : (data.facets.find((f) => f.key === args.secondary && f.key !== main.key) ?? null)
  if (args.secondary !== undefined && !secondary) throw new ApiError('not_found', `The form has no other facet "${args.secondary}".`)
  const question = args.rq === undefined ? null : (ctx.store.config.thesis.research_questions.find((q) => q.id === args.rq) ?? null)
  if (args.rq !== undefined && !question) throw new ApiError('not_found', `The thesis has no research question ${args.rq}.`)
  return { scope, data, main, secondary, question }
}

/** The free tools of the local API: local, read-only, no Claude. */
export const WRITING_API_TOOLS: ApiTool[] = [
  freeTool({
    name: 'list_papers_for_citation',
    description: 'Every library paper a text can cite, for completion: key, title, authors, year and whether its text is indexed.',
    input: {},
    async run(ctx) {
      return ctx.cache
        .listPapers()
        .filter((r) => !r.problem)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((r) => ({ key: r.id, title: r.title, authors: r.authors_label, year: r.year, has_text: r.text_status === 'ok' }))
    }
  }),
  freeTool({
    name: 'check_citations_local',
    description:
      'Parses the citations of an Org (org-cite), LaTeX or Markdown (pandoc) text and checks each key against the library: unknown, in the trash, without indexed text, cited twice. Offsets count characters (code points) from 0. Local and free.',
    input: { text, format: format.optional().describe('Detected from the text when missing') },
    async run(ctx, args) {
      const fmt: CiteFormat = args.format ?? detectFormat(args.text)
      const library = ctx.writing.library()
      const report = resolveCitations(parseCitations(args.text, fmt), {
        papers: new Map(library.papers.map((p) => [p.id, { hasText: p.hasText }])),
        trashed: new Set(library.trashed.map((t) => t.id))
      })
      const at = codePointOffsets(args.text)
      return {
        format: fmt,
        keys: report.keys,
        unknown: report.unknown,
        trashed: report.trashed,
        no_text: report.noText,
        duplicates: report.duplicates,
        citations: report.citations.map((c) => ({
          start: at(c.start),
          end: at(c.end),
          keys: c.keys,
          page: c.page,
          states: c.states,
          duplicates: c.duplicates,
          sentence: c.sentence.text
        }))
      }
    }
  }),
  freeTool({
    name: 'bibtex_for_text',
    description: "A .bib with only the entries a text cites (the library export's entries), and a report: unknown keys with a suggestion, trashed keys, entries missing fields.",
    input: { text, format: format.optional(), order: z.enum(BIB_ORDERS).optional().describe('appearance (default) or alphabetical') },
    async run(ctx, args) {
      const bib = await ctx.writing.bibFromText(args.text, args.format ?? detectFormat(args.text))
      return { bib: chapterBibText(bib.report, args.order ?? 'appearance'), citations: bib.citations, report: bibReport(bib.report) }
    }
  }),
  freeTool({
    name: 'bibtex_for_file',
    description:
      'Like bibtex_for_text for a .tex, .org or .md file given by its absolute path, following \\input, \\include, \\subfile and #+INCLUDE only inside that file\'s folder. A symbolic link is followed: its target must be a regular file, and the includes stay inside the target\'s folder. The API answers only on 127.0.0.1 and with its token.',
    input: { path: z.string().min(1).max(4096).describe('Absolute path of the file'), order: z.enum(BIB_ORDERS).optional() },
    async run(ctx, args) {
      if (!isAbsolute(args.path)) throw new ApiError('invalid_path', 'Give the absolute path of the file.')
      // A symbolic link to a chapter is followed: what is checked and read is its target, and its includes are
      // confined to the target's folder.
      const real = await realpath(args.path).catch(() => null)
      if (!real) throw new ApiError('not_found', 'The file does not exist.')
      if (!SOURCE_EXTENSIONS.has(extname(real).toLowerCase())) throw new ApiError('invalid_path', 'Only .tex, .org and .md files (and their variants) are read.')
      const info = await stat(real).catch(() => null)
      if (!info) throw new ApiError('not_found', 'The file does not exist.')
      if (!info.isFile()) throw new ApiError('invalid_path', 'The path is not a regular file.')
      const bib = await ctx.writing.bibFromFile(real).catch(fileError)
      return {
        bib: chapterBibText(bib.report, args.order ?? 'appearance'),
        citations: bib.citations,
        files: bib.files,
        skipped: bib.skipped,
        report: bibReport(bib.report)
      }
    }
  }),
  freeTool({
    name: 'outline',
    description:
      "The state-of-the-art outline the app's «Esquema» builds: one section per value of a facet (subsections by a second one), each paper with its one-liner and confirmed relations, and the gaps. Rendered as Org, LaTeX or Markdown.",
    input: OUTLINE_INPUT,
    async run(ctx, args) {
      const { data, main, secondary, question } = await outlineChoice(ctx, args)
      const outline = buildOutline({ papers: data.papers, facet: main, secondary, relations: data.relations, onlyReviewed: args.reviewed_only ?? false, question })
      const fmt = args.format ?? 'org'
      return {
        format: fmt,
        facet: main.key,
        secondary: secondary?.key ?? null,
        papers: data.papers.length,
        gaps: outline.gaps,
        text: renderOutline(outline, { format: fmt, labels: OUTLINE_LABELS })
      }
    }
  }),
  freeTool({
    name: 'find_passages',
    description:
      'Full-text search over the indexed text of the library (all words must appear), optionally only in some papers. Each passage has its paper key, title, page, the snippet and the sentence that best matches.',
    input: {
      query: z.string().min(1).max(200),
      keys: z.array(key).max(20).optional().describe('Only these papers'),
      limit: z.number().int().min(1).max(MAX_PASSAGES).optional()
    },
    async run(ctx, args) {
      const limit = args.limit ?? 10
      const hits = args.keys?.length
        ? (await Promise.all(args.keys.map((k) => ctx.library.searchText(args.query, k, Math.min(limit, 20))))).flat().slice(0, limit)
        : await ctx.library.searchText(args.query, undefined, Math.min(limit, 20))
      return hits.map((h) => ({
        key: h.paper_id,
        title: ctx.cache.getPaper(h.paper_id)?.title ?? h.paper_id,
        page: h.page,
        text: h.text,
        quote: bestSentence(h.text, args.query)
      }))
    }
  }),
  freeTool({
    name: 'open_in_app',
    description: "Brings the app's window to the front and shows the paper at that page, with the quote highlighted when given.",
    input: {
      key,
      page: z.number().int().min(1).optional(),
      quote: z.string().max(1000).optional()
    },
    async run(ctx, args) {
      requirePaper(ctx, args.key)
      ctx.openInApp({ paper: args.key, page: args.page ?? null, quote: args.quote?.trim() || null })
      return { opened: true }
    }
  })
]
