import { readFile } from 'node:fs/promises'
import type { Paper } from '../../shared/schemas'
import { rekeyBibtex } from '../ingest/bibtex'
import { atomicWrite } from '../project/atomicWrite'

export const BIB_HEADER = '% Generated from papers/*/paper.yaml by the research app. Do not edit: changes are overwritten.'

export function renderLibraryBib(papers: Pick<Paper, 'id' | 'bibtex'>[]): string {
  const entries = [...papers]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => {
      try {
        return rekeyBibtex(p.bibtex, p.id)
      } catch {
        return `% skipped ${p.id}: invalid BibTeX`
      }
    })
  return `${BIB_HEADER}\n\n${entries.join('\n\n')}\n`
}

/** Returns true when the file changed; an unchanged library is not rewritten (no sync churn). */
export async function writeLibraryBib(path: string, papers: Pick<Paper, 'id' | 'bibtex'>[]): Promise<boolean> {
  const text = renderLibraryBib(papers)
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current === text) return false
  await atomicWrite(path, text)
  return true
}
