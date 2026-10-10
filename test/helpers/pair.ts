import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IndexCache } from '../../src/main/cache/IndexCache'
import type { ProjectStore } from '../../src/main/project/ProjectStore'
import type { Paper } from '../../src/shared/schemas'
import { samplePaper } from './papers'
import { makePdf } from './pdf'

export const DRAIN_ID = 'he2017drain'
export const LOGHUB_ID = 'zhu2020loghub'
export const DRAIN_PAGES = ['Drain parses log messages online with a fixed depth parse tree.', 'Drain reaches the highest accuracy on five datasets.']
export const LOGHUB_PAGES = ['Loghub is a large collection of system log datasets.', 'We evaluate Drain on all sixteen Loghub datasets and extend its parser.']

export function drainPaper(): Paper {
  return samplePaper({
    abstract: 'An online log parser.',
    identifiers: { doi: '10.1109/icws.2017.13', openalex: 'W2754665629' },
    citations: { source: 'openalex', fetched_at: '2026-10-01T00:00:00.000Z', openalex_id: 'W2754665629', references: [], cited_by_count: 900 }
  })
}

export function loghubPaper(): Paper {
  return samplePaper({
    id: LOGHUB_ID,
    title: 'Loghub: A Large Collection of System Log Datasets',
    year: 2020,
    venue: 'ISSRE',
    abstract: 'A collection of log datasets.',
    identifiers: { arxiv: '2008.06448' },
    bibtex: '@misc{zhu2020loghub,\n  title = {Loghub}\n}',
    citations: { source: 'openalex', fetched_at: '2026-10-01T00:00:00.000Z', openalex_id: 'W3049160591', references: ['W2754665629'], cited_by_count: 300 }
  })
}

/**
 * Drain and Loghub (Loghub cites Drain), two pages of text each. Without `index`, the cache is filled by hand;
 * with it, a real PDF is written for each paper and the app's own indexing runs (so later reindexing keeps the text).
 */
export async function seedPair(store: ProjectStore, cache: IndexCache, opts: { index?: (id: string) => Promise<void> } = {}): Promise<void> {
  const papers: [Paper, string[]][] = [
    [drainPaper(), DRAIN_PAGES],
    [loghubPaper(), LOGHUB_PAGES]
  ]
  for (const [paper, pages] of papers) {
    await store.writePaper(paper, null)
    if (opts.index) {
      await writeFile(join(store.paperDir(paper.id), 'paper.pdf'), await makePdf(pages.map((line) => [line])))
      await opts.index(paper.id)
    } else {
      cache.upsertPaper(paper, 'h', false)
      cache.setText(paper.id, `t-${paper.id}`, 'ok', pages.map((text, i) => ({ index: i, page: i + 1, text })))
    }
  }
}
