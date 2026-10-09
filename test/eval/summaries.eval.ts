import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProjectSession } from '../../src/main/library/ProjectSession'
import { LLM_MODELS, SUMMARY_FIELD_KEYS, type Evidence, type ExtractionFile, type LlmConfig, type SummaryFile } from '../../src/shared/summary'

/**
 * Opt-in evaluation against the real Claude CLI, on a disposable copy of a real project.
 * Never touches the original project. Usage:
 *
 *   EVAL_PROJECT=~/path/to/project pnpm eval:summaries
 *   EVAL_MODEL=haiku EVAL_LIMIT=3 EVAL_PROJECT=~/path/to/project pnpm eval:summaries
 *
 * This spends the user's Claude quota: never set EVAL_PROJECT from an automated run.
 */

const EVAL_PROJECT = process.env.EVAL_PROJECT
const EVAL_MODEL = process.env.EVAL_MODEL ?? 'sonnet'
const EVAL_LIMIT = Number(process.env.EVAL_LIMIT ?? 5)

interface PaperResult {
  paperId: string
  title: string
  ok: boolean
  error: string | null
  costUsd: number
  evidenceFound: number
  evidenceTotal: number
  proposed: string[]
  seconds: number
}

async function copyProjectWithoutCache(src: string, dest: string): Promise<void> {
  await cp(src, dest, {
    recursive: true,
    filter: (source) => {
      const rel = relative(src, source)
      return rel !== '.cache' && !rel.startsWith(`.cache${sep}`)
    }
  })
}

async function clearGeneratedFiles(projectRoot: string): Promise<void> {
  const papersDir = join(projectRoot, 'papers')
  const ids = await readdir(papersDir, { withFileTypes: true }).then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name))
  for (const id of ids) {
    await rm(join(papersDir, id, 'summary.md'), { force: true })
    await rm(join(papersDir, id, 'extraction.yaml'), { force: true })
  }
}

function evidenceStats(summary: SummaryFile | null, extraction: ExtractionFile | null): { found: number; total: number } {
  const lists: Evidence[][] = []
  if (summary) for (const key of SUMMARY_FIELD_KEYS) lists.push(summary.fields[key].evidence)
  if (extraction) for (const key of Object.keys(extraction.facets)) lists.push(extraction.facets[key]?.evidence ?? [])
  const all = lists.flat()
  return { found: all.filter((e) => e.found).length, total: all.length }
}

function proposedValues(extraction: ExtractionFile | null): string[] {
  if (!extraction) return []
  const out: string[] = []
  for (const [key, entry] of Object.entries(extraction.facets)) for (const value of entry.proposed) out.push(`${key}=${value}`)
  return out
}

function printReport(results: PaperResult[]): void {
  console.table(
    results.map((r) => ({
      paper: r.paperId,
      status: r.ok ? 'ok' : `error: ${r.error}`,
      cost_usd_est: r.costUsd.toFixed(4),
      evidence: `${r.evidenceFound}/${r.evidenceTotal}`,
      proposed: r.proposed.join(', '),
      seconds: r.seconds.toFixed(1)
    }))
  )
  const totalCost = results.reduce((sum, r) => sum + r.costUsd, 0)
  const totalSeconds = results.reduce((sum, r) => sum + r.seconds, 0)
  const oks = results.filter((r) => r.ok).length
  console.log(`Totals: ${oks}/${results.length} ok, ${totalCost.toFixed(4)} USD est., ${totalSeconds.toFixed(1)} s`)
}

if (!EVAL_PROJECT) {
  describe.skip('summaries eval (set EVAL_PROJECT=~/path/to/project pnpm eval:summaries to run; spends Claude quota)', () => {
    it('skipped', () => undefined)
  })
} else {
  describe('summaries eval', () => {
    it(`summarizes up to ${EVAL_LIMIT} papers with the real Claude CLI (model=${EVAL_MODEL})`, async () => {
      if (!LLM_MODELS.includes(EVAL_MODEL as LlmConfig['model'])) {
        throw new Error(`Invalid EVAL_MODEL "${EVAL_MODEL}"; expected one of ${LLM_MODELS.join(', ')}`)
      }

      const dest = await mkdtemp(join(tmpdir(), 'research-eval-'))
      await copyProjectWithoutCache(EVAL_PROJECT!, dest)
      await clearGeneratedFiles(dest)

      const session = await ProjectSession.open(dest, { contactEmail: '', watch: false, deviceId: 'eval' })
      try {
        await session.summaries.ensureForm()
        await session.store.updateConfig({ llm: { ...session.store.config.llm, model: EVAL_MODEL as LlmConfig['model'] } })

        const ids = session.cache
          .listPapers()
          .filter((row) => row.text_status === 'ok')
          .slice(0, EVAL_LIMIT)
          .map((row) => ({ id: row.id, title: row.title }))

        const results: PaperResult[] = []
        for (const { id, title } of ids) {
          const startedAt = Date.now()
          let ok = true
          let error: string | null = null
          try {
            await session.summaries.run(id, {})
          } catch (err) {
            ok = false
            error = err instanceof Error ? err.message : String(err)
          }
          const seconds = (Date.now() - startedAt) / 1000
          const summaryRead = await session.store.readSummary(id)
          const extractionRead = await session.store.readExtraction(id)
          const summary = summaryRead?.ok ? summaryRead.value : null
          const extraction = extractionRead?.ok ? extractionRead.value : null
          const { found, total } = evidenceStats(summary, extraction)
          results.push({
            paperId: id,
            title,
            ok,
            error,
            costUsd: summary?.generated.cost_usd_est ?? 0,
            evidenceFound: found,
            evidenceTotal: total,
            proposed: proposedValues(extraction),
            seconds
          })
        }

        printReport(results)
        await writeFile(join(dest, 'eval-report.json'), JSON.stringify({ model: EVAL_MODEL, results }, null, 2))
        console.log(`Full copy and report kept at: ${dest}`)

        expect(results.length).toBeGreaterThan(0)
      } finally {
        await session.close()
      }
    })
  })
}
