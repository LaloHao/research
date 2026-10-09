import { z } from 'zod'
import { PDF_POLICIES } from '../shared/schemas'
import { ExtractionFormSchema, LLM_MODELS, ThesisContextSchema } from '../shared/summary'

const paperIdSchema = z.string().regex(/^[a-z][a-z0-9]*$/)

/** Validators for arguments arriving from the renderer: anything unexpected is rejected before it reaches the app. */
export const ipcArgs = {
  paperId: paperIdSchema,
  projectName: z.string().trim().min(1),
  text: z.string(),
  optionalText: z.string().optional(),
  hash: z.string().nullable(),
  paths: z.array(z.string().min(1)),
  jobId: z.number().int().nonnegative(),
  /** `lastProjectPath` is managed by the main process only. */
  settingsPatch: z.strictObject({ contactEmail: z.string().optional() }),
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
    max_input_chars: z.number().int().positive().optional(),
    budget: z
      .strictObject({
        per_operation_usd: z.number().positive().optional(),
        per_batch_usd: z.number().positive().optional(),
        per_month_usd: z.number().positive().nullable().optional()
      })
      .optional()
  }),
  runOptions: z.strictObject({ force: z.boolean().optional(), model: z.enum(LLM_MODELS).optional() }).optional(),
  batchOptions: z
    .strictObject({ model: z.enum(LLM_MODELS).optional(), ids: z.array(paperIdSchema).optional() })
    .optional(),
  thesisContext: ThesisContextSchema.strict(),
  extractionForm: ExtractionFormSchema.strict()
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
