import { DRAFT_ID, DraftMetaSchema, type DraftFile, type DraftMeta, type DraftVersion } from '../../shared/writing/draft'
import { sha256 } from './atomicWrite'
import { cleanMessageText } from './chatFile'
import type { ReadResult } from './errors'
import { parseFrontmatterFile, toFrontmatter } from './yamlFile'

export const DRAFTS_DIR = 'drafts'
/** A version's heading, in the UI's language like the chats' headings (the user reads and edits the file by hand). */
export const VERSION_HEADING = 'Versión'

const HEADING = /^## Versión ([1-9][0-9]*)\s*$/
/**
 * Lines written with one more leading backslash and read back with one less, so any text round-trips: lines that would
 * read as a version heading (with any number of backslashes already in front), and lines that would read as git conflict
 * markers (a file with them is never overwritten, so a text must not look like one).
 */
const NEEDS_ESCAPE = /^\\*(?:## Versión [1-9][0-9]*\s*$|<{7} |={7}$|>{7} )/
const ESCAPED = /^\\(\\*(?:## Versión [1-9][0-9]*\s*$|<{7} |={7}$|>{7} ))/
const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/

export const draftFileName = (id: string): string => `${id}.md`
export const isDraftFileName = (name: string): boolean => name.endsWith('.md') && DRAFT_ID.test(name.slice(0, -3))

const nfc = (line: string): string => line.normalize('NFC')

const escapeText = (text: string): string =>
  text
    .split('\n')
    .map((l) => (NEEDS_ESCAPE.test(nfc(l)) ? `\\${l}` : l))
    .join('\n')

const unescapeText = (text: string): string =>
  text
    .split('\n')
    .map((l) => (ESCAPED.test(nfc(l)) ? l.slice(1) : l))
    .join('\n')

/** What a draft cost: the sum of its versions (the frontmatter's `cost_usd`). */
export function draftCost(versions: DraftVersion[]): number {
  return Math.round(versions.reduce((sum, v) => sum + v.cost_usd, 0) * 10000) / 10000
}

/**
 * The file as the writer keeps it: one text per version (texts cleaned like a chat message's), costs rounded to 4
 * decimals and summed into `cost_usd`. Throws when the frontmatter is invalid or the texts do not match the versions.
 */
export function normalizeDraft(file: DraftFile): DraftFile {
  if (file.texts.length !== file.meta.versions.length) throw new Error(`A draft needs one text per version (${file.texts.length} for ${file.meta.versions.length})`)
  const versions = file.meta.versions.map((v) => ({ ...v, cost_usd: Math.round(v.cost_usd * 10000) / 10000 }))
  const meta = DraftMetaSchema.parse({ ...file.meta, versions, cost_usd: draftCost(versions) })
  return { meta, texts: file.texts.map(cleanMessageText) }
}

/** drafts/<id>.md: the frontmatter, then one `## Versión N` section per version, oldest first. */
export function renderDraft(file: DraftFile): string {
  const { meta, texts } = normalizeDraft(file)
  return toFrontmatter(meta, texts.map((t, i) => `## ${VERSION_HEADING} ${i + 1}\n\n${escapeText(t)}`.trimEnd()).join('\n\n'))
}

function parseSections(body: string): string[] {
  const out: string[] = []
  let lines: string[] | null = null
  const flush = (): void => {
    if (lines) out.push(unescapeText(cleanMessageText(lines.join('\n'))))
  }
  for (const line of body.split('\n')) {
    if (HEADING.test(nfc(line))) {
      flush()
      lines = []
    } else lines?.push(line)
  }
  flush()
  return out
}

/**
 * The versions of a hand-edited file still read: a section without its frontmatter entry gets one (the file's time, an
 * unknown model, no cost), an entry without its section is dropped. Either way the next write is consistent.
 */
function reconcile(meta: DraftMeta, texts: string[]): DraftFile {
  const at = /^\S+$/.test(meta.updated_at) ? meta.updated_at : 'unknown'
  const versions = texts.map((_t, i): DraftVersion => meta.versions[i] ?? { at, model: 'unknown', cost_usd: 0, stopped: false })
  return { meta: { ...meta, versions, cost_usd: draftCost(versions) }, texts }
}

/**
 * Reads drafts/<id>.md. Text before the first version heading is ignored. Windows line endings and a leading BOM are
 * read as if absent; the hash is always that of the text on disk.
 */
export function parseDraft(text: string): ReadResult<DraftFile> {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const hash = sha256(text)
  const meta = parseFrontmatterFile(normalized, DraftMetaSchema)
  if (!meta.ok) return { ...meta, hash }
  return { ok: true, hash, value: reconcile(meta.value, parseSections(normalized.replace(FRONTMATTER, ''))) }
}
