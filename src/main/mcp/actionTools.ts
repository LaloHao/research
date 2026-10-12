import { z } from 'zod'
import { PAPER_KEY } from '../../shared/chat'
import { MAX_REQUEST_QUOTE, type ActionReadTool, type ActionTool } from '../../shared/chatActions'
import { SUGGESTION_ID } from '../../shared/facetSuggestions'
import { CONFLICT_CHOICES, CONFLICT_ID } from '../../shared/sync'
import { RELATION_ID, RELATION_TYPES } from '../../shared/typedRelations'

const paperId = z.string().max(40).regex(PAPER_KEY).describe('Key of a library paper, e.g. he2017drain')
const paperIds = (max: number) => z.array(paperId).min(1).max(max)
const requestQuote = z
  .string()
  .max(MAX_REQUEST_QUOTE)
  .optional()
  .describe("The words of the user's latest message that ask for this action, copied verbatim")
const section = z.enum(['fields', 'facets', 'thesis'])
const entryKey = z.string().min(1).max(60)
/** Paging of the read tools' lists. */
export const READ_PAGE_LIMIT = 50
const page = {
  offset: z.number().int().min(0).max(100_000).optional().describe('Entries to skip (next_offset of the previous page)'),
  limit: z.number().int().min(1).max(READ_PAGE_LIMIT).optional().describe(`Entries to return, at most ${READ_PAGE_LIMIT} (the default)`)
}

/** The arguments of each tool of the actions server. A path is never an argument: attach_pdf's file is picked by the user. */
export const ACTION_INPUTS = {
  add_paper: { identifier: z.string().trim().min(1).max(2000).describe('A DOI, an arXiv id or a URL'), request_quote: requestQuote },
  write_note: { paper_id: paperId, text: z.string().trim().min(1).max(20_000).describe('Markdown to append'), request_quote: requestQuote },
  decide_relation: {
    relation_id: z.string().max(200).regex(RELATION_ID),
    decision: z.enum(['confirm', 'reject', 'back_to_suggested', 'change_type', 'reverse']),
    type: z.enum(RELATION_TYPES).optional().describe('The new type, for change_type'),
    request_quote: requestQuote
  },
  review_summary: {
    paper_id: paperId,
    section: section.optional(),
    key: entryKey.optional().describe('A summary field or a facet key; not needed for the thesis'),
    status: z.enum(['verified', 'generated']),
    request_quote: requestQuote
  },
  edit_summary: {
    paper_id: paperId,
    section,
    key: entryKey,
    value: z.unknown().describe('fields: the new value; facets: {value}, {values}, {text} or {score, justification}; thesis: {text?, score?, research_questions?, justification?}'),
    request_quote: requestQuote
  },
  resolve_proposed_value: {
    facet: entryKey,
    value: z.string().min(1).max(200),
    decision: z.enum(['accept', 'map']),
    to: entryKey.optional().describe('For map: the allowed value it becomes'),
    request_quote: requestQuote
  },
  decide_facet_suggestion: { suggestion_id: z.string().max(300).regex(SUGGESTION_ID), decision: z.enum(['accept', 'reject', 'restore']), request_quote: requestQuote },
  restore_papers: { paper_ids: paperIds(20), request_quote: requestQuote },
  attach_pdf: { paper_id: paperId, replace: z.boolean().optional(), request_quote: requestQuote },
  summarize: { paper_ids: paperIds(50), request_quote: requestQuote },
  suggest_relations: { paper_ids: paperIds(50), request_quote: requestQuote },
  suggest_facets: { request_quote: requestQuote },
  fill_facets: { paper_ids: paperIds(200).optional(), request_quote: requestQuote },
  trash_papers: { paper_ids: paperIds(20), request_quote: requestQuote },
  delete_forever: { paper_ids: paperIds(20), request_quote: requestQuote },
  sync_now: { request_quote: requestQuote },
  resolve_sync_conflicts: {
    choices: z
      .array(z.object({ id: z.string().max(4096).regex(CONFLICT_ID), choice: z.enum(CONFLICT_CHOICES) }))
      .min(1)
      .max(100),
    request_quote: requestQuote
  },
  list_relations: { paper_id: paperId },
  list_facet_suggestions: page,
  list_trash: page,
  sync_status: {},
  sync_conflicts: page
} satisfies Record<ActionTool | ActionReadTool, Record<string, z.ZodType>>

export type ActionInput<T extends ActionTool | ActionReadTool> = z.infer<z.ZodObject<(typeof ACTION_INPUTS)[T]>>

const PAGED = ' Paged: { total, offset, items, next_offset }; call again with offset: next_offset for more.'
const ASK = " Put in request_quote the words of the user's latest message that ask for it, copied verbatim; without them the app asks the user first."
const ALWAYS_ASKS = ' The app always asks the user to approve it; the call waits for the answer.'

export const ACTION_DESCRIPTIONS: Record<ActionTool | ActionReadTool, string> = {
  add_paper: `Adds a paper to the library by its DOI, arXiv id or URL, like «Agregar» in the app, and returns its key once added.${ASK}`,
  write_note: `Appends Markdown to the end of a paper's notes (notes.md), under a dated heading.${ASK}`,
  decide_relation: `Decides a typed relation: confirm, reject, back_to_suggested, change_type (with type) or reverse. Relation ids come from list_relations.${ASK}`,
  review_summary: `Marks a summary entry as verified, or back to generated: section fields (key: a summary field), facets (key: a facet key) or thesis. Without section and with status verified, verifies the whole summary.${ASK}`,
  edit_summary: `Edits a summary entry: a field's value, a facet's value(s) or the relation to the thesis; the entry becomes edited.${ASK}`,
  resolve_proposed_value: `A value papers proposed for a facet outside the form: accept adds it to the facet's values; map merges it into the allowed value in to. Applies to every paper that proposed it.${ASK}`,
  decide_facet_suggestion: `Accepts, rejects or restores a facet suggestion (ids from list_facet_suggestions). Accepting changes the extraction form.${ASK}`,
  restore_papers: `Brings papers back from the trash into the library (keys from list_trash).${ASK}`,
  attach_pdf: `Attaches a PDF to a paper. The user picks the file in the app: never ask for a path. With replace: true it replaces the paper's current PDF; ask the user before doing that.${ALWAYS_ASKS}`,
  summarize: `Queues a summary with Claude for each of these papers, as one batch. It costs money: the user sees the estimate.${ALWAYS_ASKS}`,
  suggest_relations: `Queues typed relation suggestions for these papers, as one batch. It costs money.${ALWAYS_ASKS}`,
  suggest_facets: `Queues one facet suggestion run over the library. It costs money.${ALWAYS_ASKS}`,
  fill_facets: `Queues filling the facets added to the form after these papers (or all papers) were summarized, as one batch. It costs money.${ALWAYS_ASKS}`,
  trash_papers: `Moves papers from the library to the trash; they can be restored.${ALWAYS_ASKS}`,
  delete_forever: `Deletes papers that are in the trash for good, with their relations. It cannot be undone.${ALWAYS_ASKS}`,
  sync_now: `Syncs the project with git now: commit, fetch, merge and push.${ALWAYS_ASKS}`,
  resolve_sync_conflicts: `Finishes a sync that stopped on conflicts, with a choice per conflict id from sync_conflicts: ours keeps this machine's version, theirs the other machine's.${ALWAYS_ASKS}`,
  list_relations: "A paper's typed relations, by status (suggested, confirmed, rejected), with their ids.",
  list_facet_suggestions: `The facet suggestions with their ids, status and whether each still applies to the form.${PAGED}`,
  list_trash: `The papers in the trash, by key, with their titles.${PAGED}`,
  sync_status: "The git sync's state: whether it is set up, its phase, uncommitted changes, unpushed commits, conflicts and the last error.",
  sync_conflicts: `The conflicts of the sync waiting for a decision, with their ids, paths and what each machine did.${PAGED}`
}
