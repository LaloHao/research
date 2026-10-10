import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { toYaml } from '../../../src/main/project/yamlFile'
import { samplePaper } from '../../helpers/papers'
import { tmpDir } from '../../helpers/tmp'

const citations = {
  source: 'openalex' as const,
  fetched_at: '2026-10-09T12:00:00.000Z',
  openalex_id: 'W2754665629',
  references: ['W66551789', 'W1532325895'],
  cited_by_count: 904
}

describe('ProjectStore citations and snowball', () => {
  it('writes and reads the citations block of paper.yaml', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    await store.writePaper({ ...samplePaper(), citations }, null)
    const read = await store.readPaper('he2017drain')
    expect(read.ok && read.value.citations).toEqual(citations)
    const raw = parse(await readFile(join(store.paperDir('he2017drain'), 'paper.yaml'), 'utf8'))
    expect(raw.citations.references).toEqual(['W66551789', 'W1532325895'])
  })

  it('reads a paper whose citations block is broken, without the block', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    await store.writePaper(samplePaper(), null)
    await writeFile(join(store.paperDir('he2017drain'), 'paper.yaml'), toYaml({ ...samplePaper(), citations: { source: 'openalex', references: 'oops' } }))
    const read = await store.readPaper('he2017drain')
    expect(read.ok).toBe(true)
    expect(read.ok && read.value.citations).toBeUndefined()
  })

  it('saves dismissed candidates in project.yaml and reads them back', async () => {
    const root = await tmpDir()
    const store = await ProjectStore.create(root, 'Thesis')
    await store.updateConfig({ snowball: { dismissed: ['W1234567890'] } })
    expect((await ProjectStore.open(root)).config.snowball.dismissed).toEqual(['W1234567890'])
    expect(parse(await readFile(join(root, 'project.yaml'), 'utf8')).snowball).toEqual({ dismissed: ['W1234567890'] })
  })

  it('keeps an invalid snowball block on disk until it is rewritten on purpose', async () => {
    const root = await tmpDir()
    await ProjectStore.create(root, 'Thesis')
    const file = join(root, 'project.yaml')
    await writeFile(file, toYaml({ ...parse(await readFile(file, 'utf8')), snowball: { dismissed: 'W1' } }))
    const store = await ProjectStore.open(root)
    expect(store.config.snowball.dismissed).toEqual([])
    await store.updateConfig({ name: 'Renamed' })
    expect(parse(await readFile(file, 'utf8')).snowball).toEqual({ dismissed: 'W1' })
    await store.updateConfig({ snowball: { dismissed: ['W2'] } })
    expect(parse(await readFile(file, 'utf8')).snowball).toEqual({ dismissed: ['W2'] })
  })
})
