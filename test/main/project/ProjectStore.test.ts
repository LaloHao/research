import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { ConflictError, ProjectError } from '../../../src/main/project/errors'
import { samplePaper } from '../../helpers/papers'
import { tmpDir } from '../../helpers/tmp'

describe('ProjectStore', () => {
  it('creates a project with defaults, papers dir and a managed .gitignore', async () => {
    const root = await tmpDir()
    const store = await ProjectStore.create(root, 'Thesis')
    expect(store.config.name).toBe('Thesis')
    expect(await readFile(join(root, 'project.yaml'), 'utf8')).toContain('content_language: en')
    expect(existsSync(join(root, 'papers'))).toBe(true)
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('.cache/')
  })

  it('refuses to create over an existing project and to open a folder without one', async () => {
    const root = await tmpDir()
    await ProjectStore.create(root, 'Thesis')
    await expect(ProjectStore.create(root, 'Again')).rejects.toBeInstanceOf(ProjectError)
    await expect(ProjectStore.create(root, 'Again')).rejects.toMatchObject({ code: 'project_exists' })
    await expect(ProjectStore.open(await tmpDir())).rejects.toMatchObject({ name: 'ProjectError', code: 'not_a_project' })
    await writeFile(join(root, 'project.yaml'), 'schema_version: 1\n')
    await expect(ProjectStore.open(root)).rejects.toMatchObject({ code: 'invalid_project' })
  })

  it('preserves unknown project.yaml keys across updates', async () => {
    const root = await tmpDir()
    await writeFile(join(root, 'project.yaml'), 'schema_version: 1\nname: Thesis\nprotocol:\n  rq:\n    - RQ1\n')
    const store = await ProjectStore.open(root)
    await store.updateConfig({ name: 'Renamed' })
    const text = await readFile(join(root, 'project.yaml'), 'utf8')
    expect(text).toContain('name: Renamed')
    expect(text).toContain('- RQ1')
  })

  it('rewrites ignore files when the pdf policy changes', async () => {
    const root = await tmpDir()
    const store = await ProjectStore.create(root, 'Thesis')
    await store.updateConfig({ pdfs: { policy: 'untracked' } })
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('papers/*/paper.pdf')
    await store.updateConfig({ pdfs: { policy: 'lfs' } })
    expect(await readFile(join(root, '.gitignore'), 'utf8')).not.toContain('papers/*/paper.pdf')
    expect(await readFile(join(root, '.gitattributes'), 'utf8')).toContain('filter=lfs')
  })

  it('writes papers with hash checks', async () => {
    const root = await tmpDir()
    const store = await ProjectStore.create(root, 'Thesis')
    const hash = await store.writePaper(samplePaper(), null)
    const read = await store.readPaper('he2017drain')
    expect(read).toMatchObject({ ok: true, hash })
    await expect(store.writePaper(samplePaper(), null)).rejects.toBeInstanceOf(ConflictError)

    // Someone edits the file outside the app: the stale hash must not overwrite it.
    await writeFile(join(root, 'papers/he2017drain/paper.yaml'), (await readFile(join(root, 'papers/he2017drain/paper.yaml'), 'utf8')) + '# edited\n')
    await expect(store.writePaper(samplePaper({ title: 'X' }), hash)).rejects.toBeInstanceOf(ConflictError)
  })

  it('reports a paper.yaml whose id does not match its folder', async () => {
    const root = await tmpDir()
    const store = await ProjectStore.create(root, 'Thesis')
    const hash = await store.writePaper(samplePaper(), null)
    await mkdir(join(root, 'papers/copied'), { recursive: true })
    await writeFile(join(root, 'papers/copied/paper.yaml'), await readFile(join(root, 'papers/he2017drain/paper.yaml'), 'utf8'))
    expect(await store.readPaper('copied')).toEqual({
      ok: false,
      hash,
      problem: { kind: 'invalid_schema', message: 'id he2017drain does not match folder copied' }
    })
  })

  it('lists only folders that contain a paper.yaml, sorted', async () => {
    const root = await tmpDir()
    const store = await ProjectStore.create(root, 'Thesis')
    await store.writePaper(samplePaper({ id: 'zhu2020loghub' }), null)
    await store.writePaper(samplePaper(), null)
    await mkdir(join(root, 'papers/stray'), { recursive: true })
    expect(await store.listPaperIds()).toEqual(['he2017drain', 'zhu2020loghub'])
  })

  it('reads and writes notes with hash checks', async () => {
    const root = await tmpDir()
    const store = await ProjectStore.create(root, 'Thesis')
    await store.writePaper(samplePaper(), null)
    expect(await store.readNotes('he2017drain')).toEqual({ text: '', hash: null })
    const h = await store.writeNotes('he2017drain', 'first', null)
    expect(await store.readNotes('he2017drain')).toEqual({ text: 'first', hash: h })
    await expect(store.writeNotes('he2017drain', 'second', null)).rejects.toBeInstanceOf(ConflictError)
  })

  it('places PDFs according to the policy and resolves either location', async () => {
    const root = await tmpDir()
    const store = await ProjectStore.create(root, 'Thesis')
    expect(store.pdfLocation('he2017drain', { redownloadable: true })).toBe(join(root, 'papers/he2017drain/paper.pdf'))
    await store.updateConfig({ pdfs: { policy: 'download_on_demand' } })
    expect(store.pdfLocation('he2017drain', { redownloadable: true })).toBe(join(root, '.cache/pdfs/he2017drain.pdf'))
    expect(store.resolvePdf('he2017drain')).toBeNull()
    const sha = await store.writePdf('he2017drain', new TextEncoder().encode('%PDF-1.7 fake'), { redownloadable: true })
    expect(sha).toHaveLength(64)
    expect(store.resolvePdf('he2017drain')).toBe(join(root, '.cache/pdfs/he2017drain.pdf'))
  })

  it('never keeps a PDF that cannot be downloaded again only in the cache', async () => {
    const root = await tmpDir()
    const store = await ProjectStore.create(root, 'Thesis')
    await store.updateConfig({ pdfs: { policy: 'download_on_demand' } })
    expect(store.pdfLocation('he2017drain', { redownloadable: false })).toBe(join(root, 'papers/he2017drain/paper.pdf'))
    await store.writePdf('he2017drain', new TextEncoder().encode('%PDF-1.7 fake'), { redownloadable: false })
    expect(store.resolvePdf('he2017drain')).toBe(join(root, 'papers/he2017drain/paper.pdf'))
  })

  it('stores readable content for web pages', async () => {
    const root = await tmpDir()
    const store = await ProjectStore.create(root, 'Thesis')
    expect(await store.readContent('acme2024database')).toBeNull()
    await store.writeContent('acme2024database', '# Title\n\nBody')
    expect(await store.readContent('acme2024database')).toBe('# Title\n\nBody')
  })
})
