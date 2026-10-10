import { cp, mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { InProcessEmbeddingRuntime } from '../../src/main/embeddings/EmbeddingRuntime'
import { ProjectSession } from '../../src/main/library/ProjectSession'
import { neighbours, TOP_K, WEIGHTS, type PaperSignals, type Weights } from '../../src/main/relations/similarity'

/**
 * Opt-in evaluation of the similarity with the real local model, on a disposable copy of a real project
 * (the original is never written). Usage:
 *
 *   EVAL_PROJECT=~/path/to/project pnpm eval:similarity
 *
 * EVAL_MODELS_DIR (default ~/.cache/research-eval-models) keeps the ~470 MB model between runs.
 * EVAL_FETCH_CITATIONS=1 refreshes citations from OpenAlex first (spends part of the daily OpenAlex budget).
 */

const EVAL_PROJECT = process.env.EVAL_PROJECT
const EVAL_MODELS_DIR = process.env.EVAL_MODELS_DIR ?? join(homedir(), '.cache', 'research-eval-models')
const FETCH_CITATIONS = process.env.EVAL_FETCH_CITATIONS === '1'

/** The direct-citation signal is always off: recall measures how well the other signals find real links. */
const VARIANTS: Record<string, Weights> = {
  default_without_direct: { ...WEIGHTS, direct: 0 },
  content_only: { content: 1, coupling: 0, facets: 0, cocitation: 0, direct: 0 },
  citations_and_facets: { content: 0, coupling: WEIGHTS.coupling, facets: WEIGHTS.facets, cocitation: WEIGHTS.cocitation, direct: 0 },
  more_content: { content: 0.6, coupling: 0.2, facets: 0.1, cocitation: 0.1, direct: 0 }
}

/** Share of internal citation links (a cites b) where b is among a's top-k neighbours. */
function citationRecall(papers: PaperSignals[], weights: Weights): { hits: number; links: number } {
  const byOpenAlex = new Map(papers.flatMap((p) => (p.openalexId ? [[p.openalexId, p.id] as const] : [])))
  const top = new Map<string, Set<string>>()
  for (const pair of neighbours(papers, TOP_K, weights)) top.set(pair.a, (top.get(pair.a) ?? new Set()).add(pair.b))
  let hits = 0
  let links = 0
  for (const p of papers) {
    for (const ref of p.references) {
      const cited = byOpenAlex.get(ref)
      if (!cited || cited === p.id) continue
      links++
      if (top.get(p.id)?.has(cited)) hits++
    }
  }
  return { hits, links }
}

if (!EVAL_PROJECT) {
  describe.skip('similarity eval (set EVAL_PROJECT=~/path/to/project pnpm eval:similarity to run; downloads a ~470 MB model once)', () => {
    it('skipped', () => undefined)
  })
} else {
  describe('similarity eval', () => {
    it('embeds a copy of the project with the real model and compares weightings', async () => {
      const dest = await mkdtemp(join(tmpdir(), 'research-eval-similarity-'))
      await cp(EVAL_PROJECT!, dest, {
        recursive: true,
        filter: (source) => {
          const rel = relative(EVAL_PROJECT!, source)
          return rel !== '.cache' && !rel.startsWith(`.cache${sep}`)
        }
      })
      const runtime = new InProcessEmbeddingRuntime(EVAL_MODELS_DIR)
      const session = await ProjectSession.open(dest, { contactEmail: '', watch: false, deviceId: 'eval', embeddings: runtime })
      try {
        if (FETCH_CITATIONS) {
          session.citations.requestUpdate()
          await session.queue.whenIdle()
        }
        if ((await runtime.status()).state !== 'ready') {
          await session.similarity.requestModelDownload()
          await session.queue.whenIdle()
        }
        await session.similarity.enqueueStale()
        const started = Date.now()
        await session.queue.whenIdle()
        const seconds = (Date.now() - started) / 1000
        await session.similarity.requestRecompute()

        const papers = session.similarity.signals()
        const withVectors = papers.filter((p) => p.vector).length
        console.log(`Papers: ${papers.length} · with vectors: ${withVectors} · embedding time: ${seconds.toFixed(1)} s`)
        console.table(
          Object.entries(VARIANTS).map(([variant, weights]) => {
            const { hits, links } = citationRecall(papers, weights)
            return { variant, links, hits, recall_at_10: links ? (hits / links).toFixed(2) : 'n/a' }
          })
        )
        for (const p of papers.slice(0, 5)) {
          console.log(`\n${p.id}`)
          for (const n of session.cache.similarFor(p.id).slice(0, 3)) console.log(`  ${n.score.toFixed(3)}  ${n.other}  ${JSON.stringify(n.reasons)}`)
        }
        console.log(`\nCopy kept at: ${dest}`)
        expect(withVectors).toBeGreaterThan(0)
      } finally {
        await session.close()
        await runtime.dispose()
      }
    })
  })
}
