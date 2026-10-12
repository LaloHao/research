import { isAbsolute, win32 } from 'node:path'
import { z } from 'zod'
import { ACTION_ID, CHAT_ID, MAX_CHAT_MESSAGE, MAX_CHAT_TITLE, MAX_EXCERPT, PAPER_KEY } from '../shared/chat'
import { SUGGESTION_ID } from '../shared/facetSuggestions'
import {
  CRITERION_ID,
  DECISION_ID,
  MAPPING_ID,
  MAX_QUERY,
  MAX_REASON,
  OPENALEX_TYPES,
  PHASES,
  ProtocolDraftSchema,
  QUEUE_FILTERS,
  RECORD_ID,
  SCREENING_SUGGESTION_ID,
  SEARCH_CAP,
  SEARCH_ID,
  SNOWBALL_DIRECTIONS,
  USER_DECISIONS
} from '../shared/mapping'
import { CANDIDATE_DIRECTIONS, OPENALEX_ID } from '../shared/relations'
import { PDF_POLICIES } from '../shared/schemas'
import { AUTO_SYNC_MINUTES, CLOSE_DECISIONS, CONFLICT_CHOICES, CONFLICT_ID, CONFLICT_VERSION, isRemoteUrl } from '../shared/sync'
import { AUTO_SUGGEST_FACETS_AFTER_MAX, ExtractionFormSchema, FacetDefSchema, LLM_MODELS, ThesisContextSchema } from '../shared/summary'
import { MAX_JUSTIFICATION, RELATION_ID, RELATION_STATUSES, RELATION_TYPES } from '../shared/typedRelations'

const paperIdSchema = z.string().regex(/^[a-z][a-z0-9]*$/)
const facetKeySchema = z.string().regex(/^[a-z][a-z0-9_]*$/)
/** A conversation id: `<yyyymmdd>-<hhmmss>-<4 hex>`, plus up to 8 sync-copy suffixes. */
const chatIdSchema = z.string().max(100).regex(CHAT_ID)
/** A paper key named by the chat (scope, excerpt, filter, notes target), with a bound on its length. */
const chatPaperSchema = z.string().max(200).regex(PAPER_KEY)
/** An approval or an action of a conversation: six lowercase hex characters. */
const actionIdSchema = z.string().length(6).regex(ACTION_ID)
const llmModelSchema = z.enum(LLM_MODELS)
const recordIdSchema = z.string().regex(RECORD_ID)
const phaseSchema = z.enum(PHASES)
const yearSchema = z.number().int().min(1800).max(2200).nullable()
/** The protocol draft with every nested object strict as well: only the editable fields reach the service. */
const draftItemSchema = ProtocolDraftSchema.shape.inclusion.element.strict()
const protocolDraftSchema = ProtocolDraftSchema.extend({
  research_questions: z.array(draftItemSchema).max(50),
  inclusion: z.array(draftItemSchema).max(50),
  exclusion: z.array(draftItemSchema).max(50),
  years: ProtocolDraftSchema.shape.years.strict()
}).strict()

/** Validators for arguments arriving from the renderer: anything unexpected is rejected before it reaches the app. */
export const ipcArgs = {
  paperId: paperIdSchema,
  projectName: z.string().trim().min(1),
  text: z.string(),
  optionalText: z.string().optional(),
  hash: z.string().nullable(),
  paths: z.array(z.string().min(1)),
  /** A file the user picked or dropped: absolute on POSIX or Windows. */
  absolutePath: z.string().min(1).refine((p) => isAbsolute(p) || win32.isAbsolute(p)),
  flag: z.boolean(),
  jobId: z.number().int().nonnegative(),
  /** `lastProjectPath` is managed by the main process only. */
  settingsPatch: z.strictObject({
    contactEmail: z.string().optional(),
    openalexApiKey: z.string().optional(),
    autoSync: z.boolean().optional(),
    autoSyncMinutes: z.number().int().min(AUTO_SYNC_MINUTES.min).max(AUTO_SYNC_MINUTES.max).optional()
  }),
  projectPatch: z.strictObject({
    name: z.string().trim().min(1).optional(),
    contentLanguage: z.string().min(2).optional(),
    pdfPolicy: z.enum(PDF_POLICIES).optional()
  }),
  section: z.enum(['fields', 'facets', 'thesis']),
  fieldKey: z.string().regex(/^[a-z][a-z0-9_]*$/),
  reviewStatus: z.enum(['verified', 'generated']),
  pageNumber: z.number().int().positive().nullable(),
  paperIds: z.array(paperIdSchema).optional(),
  force: z.boolean().optional(),
  llmPatch: z.strictObject({
    model: z.enum(LLM_MODELS).optional(),
    auto_summarize: z.boolean().optional(),
    auto_suggest_relations: z.boolean().optional(),
    auto_suggest_facets: z.boolean().optional(),
    auto_suggest_facets_after: z.number().int().min(1).max(AUTO_SUGGEST_FACETS_AFTER_MAX).optional(),
    max_input_chars: z.number().int().positive().optional(),
    budget: z
      .strictObject({
        per_operation_usd: z.number().positive().optional(),
        per_batch_usd: z.number().positive().optional(),
        per_month_usd: z.number().positive().nullable().optional(),
        per_facet_suggestion_usd: z.number().positive().optional(),
        per_chat_message_usd: z.number().positive().optional()
      })
      .optional()
  }),
  runOptions: z.strictObject({ force: z.boolean().optional(), model: z.enum(LLM_MODELS).optional() }).optional(),
  batchOptions: z
    .strictObject({ model: z.enum(LLM_MODELS).optional(), ids: z.array(paperIdSchema).optional() })
    .optional(),
  thesisContext: ThesisContextSchema.strict(),
  extractionForm: ExtractionFormSchema.strict(),
  openalexId: z.string().regex(OPENALEX_ID),
  candidateQuery: z.strictObject({
    direction: z.enum(CANDIDATE_DIRECTIONS),
    minCount: z.number().int().min(1).max(1000),
    paperId: paperIdSchema.optional()
  }),
  chartQuery: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('bars'), facet: facetKeySchema, onlyReviewed: z.boolean() }),
    z.strictObject({ kind: z.literal('bubbles'), facet: facetKeySchema, facetY: facetKeySchema, onlyReviewed: z.boolean() }),
    z.strictObject({ kind: z.literal('years'), facet: facetKeySchema, onlyReviewed: z.boolean() })
  ]),
  facetFilters: z.array(z.strictObject({ facet: facetKeySchema, value: z.string().min(1) })).max(4),
  /** A bare file name for the save dialog's default: never a path. */
  exportName: z.string().regex(/^[\w.-]{1,100}\.(png|svg|csv)$/),
  exportData: z.union([z.string(), z.custom<Uint8Array>((v) => v instanceof Uint8Array)]),
  relationId: z.string().regex(RELATION_ID),
  relationStatus: z.enum(RELATION_STATUSES),
  relationType: z.enum(RELATION_TYPES),
  /** Undo sends back only the token the main process handed out; never relation data. */
  undoToken: z.uuid(),
  justification: z.string().trim().min(1).max(MAX_JUSTIFICATION),
  /** A suggestion id from facet-suggestions.yaml: `<kind>__<target>`. */
  suggestionId: z.string().max(200).regex(SUGGESTION_ID),
  /** «Editar y aceptar»: the user's version of the proposal, of one kind; checked again by the service. */
  suggestionEdit: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('new_facet'), facet: FacetDefSchema }),
      z.strictObject({ kind: z.literal('new_value'), value: facetKeySchema }),
      z.strictObject({ kind: z.literal('alias'), to: facetKeySchema })
    ])
    .optional(),
  chatId: chatIdSchema,
  /** «Renombrar»: 1–120 characters once trimmed (the service also collapses whitespace). */
  chatTitle: z.string().trim().min(1).max(MAX_CHAT_TITLE),
  chatListQuery: z.strictObject({ text: z.string().max(200).optional(), paper: chatPaperSchema.optional() }).optional(),
  /** A message to send; checked again by the chat service. */
  chatSend: z.strictObject({
    chatId: chatIdSchema.nullable(),
    scope: z.union([z.literal('library'), z.strictObject({ paper: chatPaperSchema })]),
    model: llmModelSchema,
    text: z.string().trim().min(1).max(MAX_CHAT_MESSAGE),
    excerpt: z
      .strictObject({ paper: chatPaperSchema, page: z.number().int().positive().nullable(), quote: z.string().trim().min(1).max(MAX_EXCERPT) })
      .nullable(),
    /** The switches of a new conversation; ignored for an existing one. */
    actions: z.boolean().optional(),
    sync: z.boolean().optional()
  }),
  chatModel: llmModelSchema,
  /** A conversation's switches to change («Acciones», «Sincronizar con git»): at least one, only these two. */
  chatTools: z
    .strictObject({ actions: z.boolean().optional(), sync: z.boolean().optional() })
    .refine((t) => t.actions !== undefined || t.sync !== undefined, 'no switch given'),
  /** A pending approval of a conversation. */
  approvalId: actionIdSchema,
  /** «Aprobar» (true) or «Rechazar» (false): the user's click on the card, nothing else. */
  approve: z.boolean(),
  /** An action recorded in a conversation («Deshacer»). */
  actionId: actionIdSchema,
  /** A message's position in a conversation. */
  messageIndex: z.number().int().min(0).max(100_000),
  /** «Guardar en notas del paper»: the paper the user picked; absent or null when they did not pick one. */
  notesPaper: chatPaperSchema.nullable().optional(),
  /** Papers to move to or out of the trash: at least one key. */
  trashIds: z.array(paperIdSchema).min(1),
  /** Planning «Vaciar papelera» names the whole trash explicitly; an empty or missing list never means everything. */
  trashTarget: z.union([z.literal('all'), z.array(paperIdSchema).min(1)]),
  /** A conflict id the sync handed out: `file:<path>` or `paper:<key>`. */
  conflictId: z.string().max(4096).regex(CONFLICT_ID),
  /** «Terminar sincronización»: a choice per conflict id, each with the version of the conflict the user saw. */
  conflictChoices: z.record(
    z.string().max(4096).regex(CONFLICT_ID),
    z.object({ choice: z.enum(CONFLICT_CHOICES), version: z.string().regex(CONFLICT_VERSION) }).strict()
  ),
  /** The remote the user typed for the first sync; null when only initializing the repository. */
  remoteUrl: z.string().trim().refine(isRemoteUrl).nullable(),
  closeDecision: z.enum(CLOSE_DECISIONS),
  mappingId: z.string().regex(MAPPING_ID),
  mappingTitle: z.string().trim().min(1).max(300),
  recordId: recordIdSchema,
  searchId: z.string().regex(SEARCH_ID),
  decisionId: z.string().regex(DECISION_ID),
  phase: phaseSchema,
  /** «Guardar protocolo»: the editable fields only; ids are checked again by the service. */
  protocolDraft: protocolDraftSchema,
  /** The protocol version the draft was edited from. */
  protocolVersion: z.number().int().positive().max(10_000),
  openalexSearch: z.strictObject({
    query: z.string().trim().min(1).max(MAX_QUERY),
    fromYear: yearSchema,
    toYear: yearSchema,
    types: z.array(z.enum(OPENALEX_TYPES)).max(OPENALEX_TYPES.length),
    cap: z.number().int().min(1).max(SEARCH_CAP.max)
  }),
  /** The database the export came from and the string used there; the file is named apart, by its dialog token. */
  importSource: z.strictObject({ database: z.string().trim().min(1).max(200), query: z.string().max(MAX_QUERY) }),
  /** The export file to import: the token the main process's dialog handed out for it, never a path from the window. */
  importToken: z.uuid(),
  mappingPaperIds: z.array(paperIdSchema).min(1).max(5000),
  snowballDirection: z.enum(SNOWBALL_DIRECTIONS),
  discardReason: z.string().trim().min(1).max(MAX_REASON),
  queueQuery: z.strictObject({ phase: phaseSchema, filter: z.enum(QUEUE_FILTERS) }),
  /** A user's decision: never `none` (only «Deshacer» writes it) and never who decided (the service sets it). */
  decideRequest: z.strictObject({
    recordId: recordIdSchema,
    phase: phaseSchema,
    decision: z.enum(USER_DECISIONS),
    criterion: z.string().regex(CRITERION_ID).nullable(),
    suggestionId: z.string().regex(SCREENING_SUGGESTION_ID).nullable()
  }),
  mappingRecordIds: z.array(recordIdSchema).max(10_000).optional(),
  /** A request that costs money or the OpenAlex budget: only `true`, what the window sends on the user's confirming click. */
  confirmed: z.literal(true)
}

export class InvalidIpcArgument extends Error {
  constructor(name: string) {
    super(`Invalid IPC argument: ${name}`)
    this.name = 'InvalidIpcArgument'
  }
}

export function arg<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new InvalidIpcArgument(name)
  return result.data
}
