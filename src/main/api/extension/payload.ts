import { z } from 'zod'
import { normalizeArxiv, normalizeDoi, parseInput } from '../../ingest/identifiers'
import { MAX_CAPTURE_HTML } from '../../capture/policy'
import { READER_IMAGE_LIMITS, sniffImage } from '../../capture/reader'
import { isPdf } from '../../library/LibraryService'

/** What the browser extension may send; anything past these is refused (`too_large`), never cut. */
export const EXTENSION_LIMITS = {
  html: MAX_CAPTURE_HTML,
  images: READER_IMAGE_LIMITS.count,
  imageBytes: READER_IMAGE_LIMITS.bytes,
  imagesTotal: READER_IMAGE_LIMITS.total,
  pdfBytes: 100 * 1024 * 1024,
  url: 8192,
  title: 2000,
  metaEntries: 300,
  metaKey: 100,
  metaValue: 4000
} as const

/** The largest request body the extension endpoints read: a full page with its PDF and images, in base64, plus JSON. */
export const MAX_EXTENSION_BODY = Math.ceil(((EXTENSION_LIMITS.pdfBytes + EXTENSION_LIMITS.imagesTotal) * 4) / 3) + EXTENSION_LIMITS.html * 2 + 4 * 1024 * 1024

export const IMAGE_TYPES = ['png', 'jpeg', 'gif', 'webp', 'avif'] as const

/** An invalid or too large payload: the endpoint answers 400 or 413 with this code. */
export class PayloadError extends Error {
  constructor(
    readonly code: 'invalid' | 'too_large' | 'not_a_pdf',
    message: string
  ) {
    super(message)
    this.name = 'PayloadError'
  }
}

const webUrl = z
  .string()
  .max(EXTENSION_LIMITS.url)
  .refine((value) => {
    try {
      const { protocol } = new URL(value)
      return protocol === 'http:' || protocol === 'https:'
    } catch {
      return false
    }
  }, 'An http or https URL')

/** Base64 length of `bytes` bytes (the check before decoding). */
const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

const metaValue = z.union([z.string().max(EXTENSION_LIMITS.metaValue), z.array(z.string().max(EXTENSION_LIMITS.metaValue)).max(50)])

const pageShape = {
  url: webUrl,
  final_url: webUrl.optional(),
  title: z.string().max(EXTENSION_LIMITS.title).optional(),
  // Checked for size below, so an oversized page is `too_large` rather than `invalid`.
  html: z.string(),
  meta: z.record(z.string().max(EXTENSION_LIMITS.metaKey), metaValue).optional(),
  images: z
    .array(z.object({ url: webUrl, data: z.string(), type: z.enum(IMAGE_TYPES) }).strict())
    .optional(),
  pdf: z.string().optional()
}

export const pageSchema = z.object(pageShape).strict()
export const updatePdfSchema = z.object({ key: z.string().min(1).max(200), ...pageShape }).strict()
export const identifierSchema = z
  .object({ identifier: z.string().min(1).max(EXTENSION_LIMITS.url), page_url: webUrl.optional(), title: z.string().max(EXTENSION_LIMITS.title).optional() })
  .strict()
export const lookupSchema = z
  .object({ url: webUrl, final_url: webUrl.optional(), doi: z.string().max(500).optional(), arxiv: z.string().max(100).optional() })
  .strict()
export const statusSchema = z.object({ task: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).strict()
export const openSchema = z.object({ key: z.string().min(1).max(200) }).strict()
export const pairSchema = z.object({ code: z.string().min(1).max(32) }).strict()

/** A page as the capture code uses it: validated, decoded, sniffed. */
export interface CapturedPage {
  url: string
  title: string
  html: string
  meta: Record<string, string[]>
  images: { url: string; data: Uint8Array; type: (typeof IMAGE_TYPES)[number] }[]
  pdf: Uint8Array | null
}

function decode(data: string, maxBytes: number, what: string): Uint8Array {
  if (data.length > base64Length(maxBytes)) throw new PayloadError('too_large', `${what} is larger than allowed`)
  if (data.length % 4 !== 0 || !BASE64.test(data)) throw new PayloadError('invalid', `${what} is not base64`)
  return new Uint8Array(Buffer.from(data, 'base64'))
}

/** Checks the sizes and decodes the images and the PDF; every image must really be one of `IMAGE_TYPES`, the PDF a PDF. */
export function readPage(raw: z.infer<typeof pageSchema>): CapturedPage {
  if (raw.html.length > EXTENSION_LIMITS.html) throw new PayloadError('too_large', 'The page HTML is larger than allowed')
  const meta: Record<string, string[]> = {}
  const entries = Object.entries(raw.meta ?? {})
  if (entries.length > EXTENSION_LIMITS.metaEntries) throw new PayloadError('too_large', 'Too many meta fields')
  for (const [key, value] of entries) meta[key.toLowerCase()] = (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter(Boolean)
  const list = raw.images ?? []
  if (list.length > EXTENSION_LIMITS.images) throw new PayloadError('too_large', 'Too many images')
  let total = 0
  const images = list.map((image, i) => {
    const data = decode(image.data, EXTENSION_LIMITS.imageBytes, `Image ${i + 1}`)
    if (data.byteLength > EXTENSION_LIMITS.imageBytes) throw new PayloadError('too_large', `Image ${i + 1} is larger than allowed`)
    total += data.byteLength
    if (total > EXTENSION_LIMITS.imagesTotal) throw new PayloadError('too_large', 'The images are larger than allowed together')
    const sniffed = sniffImage(data)
    if (sniffed !== image.type) throw new PayloadError('invalid', `Image ${i + 1} is not a ${image.type} image`)
    return { url: image.url, data, type: sniffed }
  })
  let pdf: Uint8Array | null = null
  if (raw.pdf !== undefined) {
    pdf = decode(raw.pdf, EXTENSION_LIMITS.pdfBytes, 'The PDF')
    if (pdf.byteLength > EXTENSION_LIMITS.pdfBytes) throw new PayloadError('too_large', 'The PDF is larger than allowed')
    if (!isPdf(pdf)) throw new PayloadError('not_a_pdf', 'The PDF does not start like a PDF')
  }
  return { url: raw.final_url ?? raw.url, title: raw.title?.trim() ?? '', html: raw.html, meta, images, pdf }
}

const DOI_FIELDS = ['citation_doi', 'prism.doi', 'dc.identifier', 'bepress_citation_doi', 'dc.identifier.doi']
const DOI = /10\.\d{4,9}\/\S+/

/** A DOI as typed or read (bare, doi:, a doi.org link); null when it is not one. */
export function cleanDoi(raw: string | undefined): string | null {
  const m = raw?.match(DOI)
  return m ? normalizeDoi(m[0]) : null
}

/**
 * The DOI and arXiv id of a page: from the meta fields the extension read (citation_doi, prism.doi, dc.identifier,
 * citation_arxiv_id), then from its URL (doi.org, arxiv.org/abs|pdf, a DOI in the path).
 */
export function pageIds(meta: Record<string, string[]>, urls: readonly string[]): { doi?: string; arxiv?: string } {
  const out: { doi?: string; arxiv?: string } = {}
  for (const field of DOI_FIELDS) {
    for (const value of meta[field] ?? []) {
      out.doi ??= cleanDoi(value) ?? undefined
    }
  }
  for (const value of meta.citation_arxiv_id ?? []) out.arxiv ??= normalizeArxiv(value) ?? undefined
  for (const url of urls) {
    const parsed = parseInput(url)
    if (parsed.kind === 'doi') out.doi ??= parsed.doi
    if (parsed.kind === 'arxiv') out.arxiv ??= parsed.arxiv
  }
  return out
}
