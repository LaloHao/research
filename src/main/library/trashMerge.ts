import { ExtractionFileSchema, SummaryFileSchema } from '../../shared/summary'
import { parseFrontmatterFile, parseYamlFile } from '../project/yamlFile'

/** Entries the user verified or edited; -1 for a file that does not parse, so it never wins over a readable one. */
export function reviewedCount(name: 'summary.md' | 'extraction.yaml', text: string): number {
  if (name === 'summary.md') {
    const read = parseFrontmatterFile(text, SummaryFileSchema)
    return read.ok ? Object.values(read.value.fields).filter((f) => f.status !== 'generated').length : -1
  }
  const read = parseYamlFile(text, ExtractionFileSchema)
  if (!read.ok) return -1
  const statuses = [...Object.values(read.value.facets).map((f) => f.status), ...(read.value.thesis_relation ? [read.value.thesis_relation.status] : [])]
  return statuses.filter((s) => s !== 'generated').length
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])

/**
 * What a merge does with one trashed file (notes.md and paper.yaml have their own rules): `adopt` it when the library has
 * none, or for summary.md/extraction.yaml when it has more reviewed entries (the library copy is then kept beside it);
 * `same` when both are identical; otherwise `keep_trashed`: the library copy stays and the trashed one is kept beside it.
 */
export function planMergeFile(name: string, mine: Uint8Array | null, theirs: Uint8Array): 'adopt' | 'keep_trashed' | 'same' {
  if (mine === null) return 'adopt'
  if (sameBytes(mine, theirs)) return 'same'
  if (name === 'summary.md' || name === 'extraction.yaml') {
    const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
    return reviewedCount(name, text(theirs)) > reviewedCount(name, text(mine)) ? 'adopt' : 'keep_trashed'
  }
  return 'keep_trashed'
}

/** Both notes survive a merge: the trashed paper's are appended under a marker naming its key. Merging twice changes nothing. */
export function mergeNotes(mine: string, theirs: string, fromId: string): string {
  if (!theirs.trim() || mine.includes(theirs.trim())) return mine
  if (!mine.trim()) return theirs
  return `${mine.trimEnd()}\n\n<!-- notes of ${fromId}, merged from the trash -->\n${theirs}`
}
