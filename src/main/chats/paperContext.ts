import type { SummaryFields } from '../../shared/summary'
import type { ProjectStore } from '../project/ProjectStore'
import type { PaperContext } from './chatPrompt'

/**
 * A library paper as a prompt shows it: its metadata and the given fields of its summary (none when it has no summary).
 * Null when it is not in the library, was trashed meanwhile or cannot be read: the run goes on without it.
 */
export async function readPaperContext(store: ProjectStore, id: string, fields: readonly (keyof SummaryFields)[]): Promise<PaperContext | null> {
  if (!store.paperExists(id)) return null
  const read = await store.readPaper(id).catch(() => null)
  if (!read?.ok) return null
  const p = read.value
  const summary = await store.readSummary(p.id).catch(() => null)
  return {
    id: p.id,
    title: p.title,
    authors: p.authors.map((a) => (a.given ? `${a.given} ${a.family}` : a.family)).join(', '),
    year: p.year ?? null,
    venue: p.venue ?? null,
    abstract: p.abstract ?? null,
    summary: summary?.ok ? Object.fromEntries(fields.map((k) => [k, String(summary.value.fields[k].value ?? '')])) : null
  }
}
