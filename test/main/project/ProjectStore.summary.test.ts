import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConflictError } from '../../../src/main/project/errors'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { toYaml } from '../../../src/main/project/yamlFile'
import { parse } from 'yaml'
import type { CostEntry } from '../../../src/shared/summary'
import { samplePaper } from '../../helpers/papers'
import { sampleExtraction, sampleSummary } from '../../helpers/summaries'
import { tmpDir } from '../../helpers/tmp'

const summary = sampleSummary()
const extraction = sampleExtraction()

async function store(): Promise<ProjectStore> {
  const s = await ProjectStore.create(await tmpDir(), 'Thesis')
  await s.writePaper(samplePaper(), null)
  return s
}

describe('ProjectStore summaries', () => {
  it('returns null when there is no summary yet', async () => {
    const s = await store()
    expect(await s.readSummary('he2017drain')).toBeNull()
    expect(await s.readExtraction('he2017drain')).toBeNull()
  })

  it('writes summary.md with frontmatter and body, hash-checked', async () => {
    const s = await store()
    const hash = await s.writeSummary('he2017drain', summary, '# Drain', null)
    const text = await readFile(join(s.paperDir('he2017drain'), 'summary.md'), 'utf8')
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toContain('# Drain')
    expect(await s.readSummary('he2017drain')).toMatchObject({ ok: true, hash })
    await expect(s.writeSummary('he2017drain', summary, '# Drain', null)).rejects.toBeInstanceOf(ConflictError)
  })

  it('writes extraction.yaml hash-checked', async () => {
    const s = await store()
    const hash = await s.writeExtraction('he2017drain', extraction, null)
    expect(await s.readExtraction('he2017drain')).toMatchObject({ ok: true, hash, value: { form_hash: 'h' } })
  })

  it('reports a broken summary as a problem instead of throwing', async () => {
    const s = await store()
    await writeFile(join(s.paperDir('he2017drain'), 'summary.md'), '---\nfields: nope\n---\n')
    expect(await s.readSummary('he2017drain')).toMatchObject({ ok: false, problem: { kind: 'invalid_schema' } })
  })
})

describe('ProjectStore costs', () => {
  const entry = (at: string, cost: number): CostEntry => ({ at, paper_id: 'he2017drain', batch_id: null, model: 'sonnet', cost_usd: cost, operation: 'summarize' })

  it('appends one line per call, one file per device, and reads them all back', async () => {
    const s = await store()
    await s.appendCost('11111111-1111-1111-1111-111111111111', entry('2026-10-08T00:00:00.000Z', 0.1))
    await s.appendCost('11111111-1111-1111-1111-111111111111', entry('2026-10-08T01:00:00.000Z', 0.2))
    await s.appendCost('22222222-2222-2222-2222-222222222222', entry('2026-10-08T02:00:00.000Z', 0.3))
    const lines = (await readFile(join(s.root, 'costs/11111111-1111-1111-1111-111111111111.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect((await s.readCosts()).map((c) => c.cost_usd).sort()).toEqual([0.1, 0.2, 0.3])
  })

  it('skips corrupt lines and rejects unsafe device ids', async () => {
    const s = await store()
    await s.appendCost('11111111-1111-1111-1111-111111111111', entry('2026-10-08T00:00:00.000Z', 0.1))
    await writeFile(join(s.root, 'costs/broken.jsonl'), 'not json\n{"cost_usd":"x"}\n')
    expect(await s.readCosts()).toHaveLength(1)
    await expect(s.appendCost('../escape', entry('2026-10-08T00:00:00.000Z', 0.1))).rejects.toThrow()
  })
})

describe('ProjectStore config blocks', () => {
  it('updates llm settings and the extraction form', async () => {
    const s = await store()
    await s.updateConfig({ llm: { ...s.config.llm, auto_summarize: true }, extraction_form: { facets: [], value_aliases: {} } })
    const text = await readFile(join(s.root, 'project.yaml'), 'utf8')
    expect(text).toContain('auto_summarize: true')
    expect(text).toContain('extraction_form:')
  })

  it('keeps an invalid llm or thesis block verbatim on disk when another part of project.yaml is written', async () => {
    const s = await store()
    const path = join(s.root, 'project.yaml')
    const raw = parse(await readFile(path, 'utf8'))
    raw.llm = { model: 'gpt-x', max_input_chars: 1000, budget: { per_batch_usd: 'ten' } }
    raw.thesis = { title: 'Mine', research_questions: [{ id: 'Q1', text: 'typo id' }] }
    await writeFile(path, toYaml(raw))
    await s.reloadConfig()
    expect(s.config.llm).toMatchObject({ model: 'sonnet', max_input_chars: 1000 })
    expect(s.config.thesis).toEqual({ title: '', description: '', research_questions: [], last_rq: 0 })

    await s.updateConfig({ name: 'Renamed' })
    const after = parse(await readFile(path, 'utf8'))
    expect(after.name).toBe('Renamed')
    expect(after.llm).toEqual(raw.llm)
    expect(after.thesis).toEqual(raw.thesis)

    // Writing a block on purpose replaces it.
    await s.updateConfig({ llm: { ...s.config.llm, model: 'haiku' } })
    const fixed = parse(await readFile(path, 'utf8'))
    expect(fixed.llm).toMatchObject({ model: 'haiku', max_input_chars: 1000 })
    expect(fixed.thesis).toEqual(raw.thesis)
    await s.updateConfig({ thesis: { title: 'New', description: '', research_questions: [] } })
    expect(parse(await readFile(path, 'utf8')).thesis).toEqual({ title: 'New', description: '', research_questions: [], last_rq: 0 })
    await s.updateConfig({ name: 'Again' })
    expect(parse(await readFile(path, 'utf8')).llm).toMatchObject({ model: 'haiku' })
  })

  it('keeps an invalid block found when the project is opened', async () => {
    const s = await store()
    const path = join(s.root, 'project.yaml')
    const raw = parse(await readFile(path, 'utf8'))
    raw.llm = { model: 'gpt-x' }
    await writeFile(path, toYaml(raw))
    const reopened = await ProjectStore.open(s.root)
    await reopened.updateConfig({ name: 'Renamed' })
    expect(parse(await readFile(path, 'utf8')).llm).toEqual({ model: 'gpt-x' })
  })
})
