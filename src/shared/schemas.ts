import { z } from 'zod'
import { LlmConfigSchema } from './summary'

export const PDF_POLICIES = ['track', 'lfs', 'untracked', 'download_on_demand'] as const
export type PdfPolicy = (typeof PDF_POLICIES)[number]

// Loose objects: later stages add keys (protocol, extraction form, …) and an older
// build must round-trip them untouched instead of dropping them on the next write.
export const ProjectConfigSchema = z.looseObject({
  schema_version: z.literal(1),
  name: z.string().min(1),
  content_language: z.string().min(2).default('en'),
  pdfs: z.object({ policy: z.enum(PDF_POLICIES) }).default({ policy: 'track' }),
  llm: LlmConfigSchema.prefault({}),
  /** Validated separately (summary/extractionForm.ts): a mistake in the form must not stop the project from opening. */
  extraction_form: z.unknown().optional()
})
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>

export const PAPER_KINDS = ['article', 'conference', 'preprint', 'book', 'chapter', 'thesis', 'report', 'web', 'other'] as const
export type PaperKind = (typeof PAPER_KINDS)[number]

/** `family` alone holds an organization or a free-form byline. */
export const AuthorSchema = z.object({
  family: z.string().min(1),
  given: z.string().optional()
})
export type Author = z.infer<typeof AuthorSchema>

export const IdentifiersSchema = z.object({
  doi: z.string().optional(),
  arxiv: z.string().optional(),
  openalex: z.string().optional(),
  url: z.string().optional()
})

export const PaperSchema = z.looseObject({
  schema_version: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9]*$/),
  kind: z.enum(PAPER_KINDS),
  title: z.string().min(1),
  authors: z.array(AuthorSchema).default([]),
  year: z.number().int().optional(),
  venue: z.string().optional(),
  abstract: z.string().optional(),
  identifiers: IdentifiersSchema.default({}),
  oa_pdf_url: z.string().optional(),
  pdf_sha256: z.string().optional(),
  bibtex: z.string().min(1),
  metadata_status: z.enum(['complete', 'incomplete']),
  added_at: z.string(),
  updated_at: z.string()
})
export type Paper = z.infer<typeof PaperSchema>
