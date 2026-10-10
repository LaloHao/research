import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProjectSession } from '../../src/main/library/ProjectSession'
import { LLM_MODELS, type LlmModel } from '../../src/shared/summary'

/**
 * Opt-in evaluation of typed relation suggestions against the real Claude CLI (an agent with the read-only
 * library MCP tools), on a disposable copy of a real project: the original is never touched and nothing is
 * written back. Usage:
 *
 *   EVAL_PROJECT=~/path/to/project pnpm eval:relations
 *   EVAL_MODEL=haiku EVAL_LIMIT=2 EVAL_PROJECT=~/path/to/project pnpm eval:relations
 *
 * This spends the user's Claude quota: never set EVAL_PROJECT from an automated run.
 */

const EVAL_PROJECT = process.env.EVAL_PROJECT
const EVAL_MODEL = (process.env.EVAL_MODEL ?? 'sonnet') as LlmModel
const EVAL_LIMIT = Number(process.env.EVAL_LIMIT ?? 3)

interface Row {
  paperId: string
  candidates: number
  suggested: number
  types: string
  toolCalls: number
  evidence: string
  dropped: string
  costUsd: number
  seconds: number
  error: string | null
}

describe.skipIf(!EVAL_PROJECT)('typed relation suggestions against real Claude', () => {
  it('suggests relations using the library tools, with checked evidence', async () => {
    expect(LLM_MODELS).toContain(EVAL_MODEL)
    const source = EVAL_PROJECT!
    const root = await mkdtemp(join(tmpdir(), 'research-eval-relations-'))
    try {
      await cp(source, root, {
        recursive: true,
        filter: (path) => {
          const rel = relative(source, path)
          return rel !== '.cache' && !rel.startsWith(`.cache${sep}`)
        }
      })
      const s = await ProjectSession.open(root, { contactEmail: '', watch: false })
      try {
        await s.similarity.requestRecompute()
        const index = s.relations.suggester.candidateIndex()
        const ids = s.library
          .list()
          .filter((r) => r.text_status === 'ok' && s.relations.suggester.candidatesFor(r.id, index).length > 0)
          .slice(0, EVAL_LIMIT)
          .map((r) => r.id)
        const rows: Row[] = []
        for (const id of ids) {
          const started = Date.now()
          const seconds = (): number => Math.round((Date.now() - started) / 1000)
          try {
            const r = await s.relations.suggester.suggest({ paperId: id, existing: s.cache.typedRelations(id), model: EVAL_MODEL })
            rows.push({
              paperId: id,
              candidates: r.candidates.length,
              suggested: r.relations.length,
              types: r.relations.map((x) => x.type).join(', '),
              toolCalls: r.toolCalls,
              evidence: `${r.evidenceFound}/${r.evidenceTotal}`,
              dropped: r.dropped.join(', '),
              costUsd: r.costUsd,
              seconds: seconds(),
              error: null
            })
          } catch (error) {
            rows.push({ paperId: id, candidates: 0, suggested: 0, types: '', toolCalls: 0, evidence: '', dropped: '', costUsd: 0, seconds: seconds(), error: (error as Error).message })
          }
        }
        console.table(rows)
        console.log('total cost (USD est.):', rows.reduce((n, r) => n + r.costUsd, 0).toFixed(4))
        expect(rows).toHaveLength(ids.length)
      } finally {
        await s.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
