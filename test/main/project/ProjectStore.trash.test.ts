import { describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { sha256 } from '../../../src/main/project/atomicWrite'
import { ConflictError, type ProjectError } from '../../../src/main/project/errors'
import { withManagedBlock } from '../../../src/main/project/gitFiles'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { siblingName } from '../../../src/main/project/trashPaths'
import { samplePaper } from '../../helpers/papers'
import { sampleSummary } from '../../helpers/summaries'
import { tmpDir } from '../../helpers/tmp'

// Lets a test make the next folder move fail, as Windows does while another program holds a file open.
const moves = vi.hoisted(() => ({ failNext: null as string | null }))
vi.mock('../../../src/main/project/atomicWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/project/atomicWrite')>()
  return {
    ...actual,
    moveDir: async (...args: Parameters<typeof actual.moveDir>) => {
      const failure = moves.failNext
      moves.failNext = null
      if (failure) throw Object.assign(new Error(failure), { code: failure })
      return actual.moveDir(...args)
    }
  }
})

const DEVICE = '22222222-2222-2222-2222-222222222222'
const AT = new Date('2026-10-11T12:00:00.000Z')
const ID = 'he2017drain'
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array | null): string | null => (b === null ? null : new TextDecoder().decode(b))

async function withPaper(): Promise<ProjectStore> {
  const store = await ProjectStore.create(await tmpDir(), 'Thesis')
  await store.writePaper(samplePaper(), null)
  await store.writeNotes(ID, 'my notes', null)
  return store
}

const code = (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e as ProjectError).code
  )

describe('ProjectStore trash', () => {
  it('moves the whole paper folder to .trash/ and records when and on which device', async () => {
    const store = await withPaper()
    await store.trashPaper(ID, DEVICE, AT)
    expect(existsSync(store.paperDir(ID))).toBe(false)
    expect(await store.listPaperIds()).toEqual([])
    expect(store.trashExists(ID)).toBe(true)
    expect(await readFile(join(store.trashDir(ID), 'notes.md'), 'utf8')).toBe('my notes')
    const trashed = { schema_version: 1, trashed_at: '2026-10-11T12:00:00.000Z', device: DEVICE }
    expect(parse(await readFile(join(store.trashDir(ID), 'trashed.yaml'), 'utf8'))).toEqual(trashed)
    const [entry] = await store.listTrash()
    expect(entry.id).toBe(ID)
    expect(entry.paper?.ok && entry.paper.value.title).toBe(samplePaper().title)
    expect(entry.trashed).toEqual(trashed)
  })

  it('refuses a missing paper, a folder without paper.yaml, a key already in the trash and an invalid device id', async () => {
    const store = await withPaper()
    expect(await code(store.trashPaper('nothere', DEVICE, AT))).toBe('trash_problem')
    await mkdir(store.paperDir('stray'), { recursive: true })
    expect(await code(store.trashPaper('stray', DEVICE, AT))).toBe('trash_problem')
    await expect(store.trashPaper(ID, '../x', AT)).rejects.toThrow('Invalid device id')
    await mkdir(store.trashDir(ID), { recursive: true })
    expect(await code(store.trashPaper(ID, DEVICE, AT))).toBe('trash_problem')
    expect(store.paperExists(ID)).toBe(true)
  })

  it('restores the folder as it was, without trashed.yaml', async () => {
    const store = await withPaper()
    await store.trashPaper(ID, DEVICE, AT)
    expect(await store.restorePaper(ID)).toEqual({ remnant: false })
    expect(store.paperExists(ID)).toBe(true)
    expect(store.trashExists(ID)).toBe(false)
    expect(existsSync(join(store.paperDir(ID), 'trashed.yaml'))).toBe(false)
    expect((await store.readNotes(ID)).text).toBe('my notes')
    expect(await store.listTrash()).toEqual([])
  })

  it('never restores over a folder that holds a paper, and reports a trash folder without paper.yaml', async () => {
    const store = await withPaper()
    await store.trashPaper(ID, DEVICE, AT)
    await store.writePaper(samplePaper({ title: 'Added again' }), null)
    expect(await code(store.restorePaper(ID))).toBe('paper_exists')
    expect(store.trashExists(ID)).toBe(true)
    await mkdir(store.trashDir('broken'), { recursive: true })
    await writeFile(join(store.trashDir('broken'), 'notes.md'), 'x')
    expect(await code(store.restorePaper('broken'))).toBe('trash_problem')
    expect((await store.listTrash()).map((e) => [e.id, e.paper === null, e.trashed === null])).toEqual([
      ['broken', true, true],
      [ID, false, false]
    ])
  })

  it('moves the trashed files into a leftover folder without paper.yaml, never overwriting', async () => {
    const store = await withPaper()
    await store.trashPaper(ID, DEVICE, AT)
    await mkdir(store.paperDir(ID), { recursive: true })
    await writeFile(join(store.paperDir(ID), 'notes.md'), 'written late')
    expect(await store.restorePaper(ID)).toEqual({ remnant: false })
    expect(store.paperExists(ID)).toBe(true)
    expect(await readFile(join(store.paperDir(ID), 'notes.md'), 'utf8')).toBe('written late')
    expect(await readFile(join(store.paperDir(ID), 'notes.trashed.md'), 'utf8')).toBe('my notes')
    expect(existsSync(join(store.paperDir(ID), 'trashed.yaml'))).toBe(false)
    expect(store.trashExists(ID)).toBe(false)
  })

  it('restores under another key with a rewritten paper.yaml', async () => {
    const store = await withPaper()
    await store.trashPaper(ID, DEVICE, AT)
    await store.writePaper(samplePaper({ title: 'Someone else' }), null)
    await store.restorePaper(ID, { as: 'he2017draina', rewrite: (p) => ({ ...p, id: 'he2017draina' }) })
    const read = await store.readPaper('he2017draina')
    expect(read.ok && read.value.title).toBe(samplePaper().title)
    expect((await store.readNotes('he2017draina')).text).toBe('my notes')
    expect(store.trashExists(ID)).toBe(false)
  })

  it('copies, keeps aside and clears trashed files for a merge, never overwriting and never deleting what it did not take', async () => {
    const store = await withPaper()
    await store.writeSummary(ID, sampleSummary(), 'Body.\n', null)
    await store.trashPaper(ID, DEVICE, AT)
    await mkdir(join(store.trashDir(ID), 'figures'))
    const B = 'he2017drainb'
    await store.writePaper(samplePaper({ id: B }), null)
    await store.writeNotes(B, 'theirs', null)
    expect(await store.listTrashedFiles(ID)).toEqual(['notes.md', 'summary.md', 'paper.yaml'])
    expect(await store.adoptTrashedFile(ID, B, 'summary.md', { expectedHash: null })).toBe(true)
    expect(text(await store.readPaperFile(B, 'summary.md'))).toBe(text(await store.readTrashedFile(ID, 'summary.md')))
    const mine = await store.readPaperFile(B, 'summary.md')
    expect(await store.adoptTrashedFile(ID, B, 'summary.md', { expectedHash: sha256(mine!) })).toBe(true)
    expect(await store.adoptTrashedFile(ID, B, 'content.md', { expectedHash: null })).toBe(false)
    await expect(store.adoptTrashedFile(ID, B, 'notes.md', { expectedHash: null })).rejects.toBeInstanceOf(ConflictError)
    expect(store.freeSibling(B, 'notes.md', 'trashed')).toBe('notes.trashed.md')
    expect(await store.adoptTrashedFile(ID, B, 'notes.md', { as: 'notes.trashed.md', expectedHash: null })).toBe(true)
    expect(store.freeSibling(B, 'notes.md', 'trashed')).toBe('notes.trashed-2.md')
    expect(await store.keepPaperFileAs(B, 'summary.md', 'before-merge')).toBe('summary.before-merge.md')
    // The subfolder nobody merged keeps the entry in the trash.
    expect(await store.finishMerge(ID, await store.listTrashedFiles(ID))).toBe(false)
    expect(await store.listTrashedFiles(ID)).toEqual([])
    expect(store.trashExists(ID)).toBe(true)
    // The entry that stays keeps its date and device.
    expect(existsSync(join(store.trashDir(ID), 'trashed.yaml'))).toBe(true)
    await store.deleteTrashed(ID)
    expect(store.trashExists(ID)).toBe(false)
  })

  it('never writes a paper file without its paper.yaml, except for a paper being created', async () => {
    const store = await withPaper()
    await store.trashPaper(ID, DEVICE, AT)
    await expect(store.writeNotes(ID, 'late', null)).rejects.toBeInstanceOf(ConflictError)
    await expect(store.writeSummary(ID, sampleSummary(), 'x', null)).rejects.toBeInstanceOf(ConflictError)
    await expect(store.writeContent(ID, 'late')).rejects.toBeInstanceOf(ConflictError)
    await expect(store.writePdf(ID, bytes('%PDF-1.7 late'), { redownloadable: false })).rejects.toBeInstanceOf(ConflictError)
    expect(existsSync(store.paperDir(ID))).toBe(false)
    await store.writeContent('acme2024page', '# Page', { newPaper: true })
    expect(await store.readContent('acme2024page')).toBe('# Page')
  })

  it('brings an existing project up to date on open: ignore rules, leftover temp folders, hidden folders', async () => {
    const root = await tmpDir()
    const created = await ProjectStore.create(root, 'Thesis')
    await created.updateConfig({ pdfs: { policy: 'untracked' } })
    await writeFile(join(root, '.gitignore'), withManagedBlock('', ['.cache/', 'papers/*/paper.pdf']))
    await mkdir(join(root, '.trash', '.he2017drain.abc123.moving'), { recursive: true })
    await mkdir(join(root, 'papers', '.hidden'), { recursive: true })
    await writeFile(join(root, 'papers', '.hidden', 'paper.yaml'), 'x')
    const store = await ProjectStore.open(root)
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('.trash/*/paper.pdf')
    expect(existsSync(join(root, '.trash', '.he2017drain.abc123.moving'))).toBe(false)
    expect(await store.listPaperIds()).toEqual([])
  })

  it('reports a subfolder left in the trash after restoring into a leftover folder, keeping its trashed.yaml', async () => {
    const store = await withPaper()
    await store.trashPaper(ID, DEVICE, AT)
    await mkdir(join(store.trashDir(ID), 'figures'))
    await mkdir(store.paperDir(ID), { recursive: true })
    expect(await store.restorePaper(ID)).toEqual({ remnant: true })
    expect(store.paperExists(ID)).toBe(true)
    expect(store.trashExists(ID)).toBe(true)
    expect(existsSync(join(store.trashDir(ID), 'trashed.yaml'))).toBe(true)
  })

  it('puts the original paper.yaml back when a restore under another key cannot move the folder', async () => {
    const store = await withPaper()
    await store.trashPaper(ID, DEVICE, AT)
    await store.writePaper(samplePaper({ title: 'Someone else' }), null)
    const rewrite = (p: ReturnType<typeof samplePaper>): ReturnType<typeof samplePaper> => ({ ...p, id: 'he2017draina' })
    moves.failNext = 'EBUSY'
    expect(await code(store.restorePaper(ID, { as: 'he2017draina', rewrite }))).toBe('folder_busy')
    const kept = await store.readTrashedPaper(ID)
    expect(kept?.ok && kept.value.id).toBe(ID)
    expect(existsSync(store.paperDir('he2017draina'))).toBe(false)
    expect(await store.restorePaper(ID, { as: 'he2017draina', rewrite })).toEqual({ remnant: false })
    const read = await store.readPaper('he2017draina')
    expect(read.ok && read.value.title).toBe(samplePaper().title)
  })

  it('names a copy kept beside another', () => {
    expect(siblingName('summary.md', 'trashed')).toBe('summary.trashed.md')
    expect(siblingName('paper.pdf', 'before-merge', 2)).toBe('paper.before-merge-2.pdf')
    expect(siblingName('README', 'trashed')).toBe('README.trashed')
  })
})
