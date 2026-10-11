import { describe, expect, it } from 'vitest'
import { mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { atomicWrite } from '../../../src/main/project/atomicWrite'
import { join } from 'node:path'
import { watchProject } from '../../../src/main/project/watcher'
import { tmpDir } from '../../helpers/tmp'

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('watchProject', () => {
  it('reports paper and config changes, ignoring cache, exports and temp files', async () => {
    const root = await tmpDir()
    await mkdir(join(root, 'papers/he2017drain'), { recursive: true })
    await mkdir(join(root, '.cache'), { recursive: true })
    const papers: string[] = []
    const files = new Set<string>()
    let configs = 0
    const stop = watchProject(
      root,
      {
        onPaper: (id, changed) => {
          papers.push(id)
          for (const f of changed) files.add(f)
        },
        onConfig: () => configs++
      },
      50
    )
    await new Promise((r) => setTimeout(r, 100))

    await writeFile(join(root, '.cache/index.sqlite'), 'x')
    await writeFile(join(root, 'papers/he2017drain/.paper.yaml.abc.tmp'), 'x')
    await writeFile(join(root, 'papers/he2017drain/paper.yaml'), 'x')
    await writeFile(join(root, 'papers/he2017drain/notes.md'), 'x')
    await writeFile(join(root, 'project.yaml'), 'x')

    await waitFor(() => papers.length > 0 && configs > 0)
    await new Promise((r) => setTimeout(r, 150))
    stop()
    expect(papers).toEqual(['he2017drain'])
    expect(files.has('paper.yaml') && files.has('notes.md')).toBe(true)
    expect([...files].some((f) => f.startsWith('.paper.yaml'))).toBe(false)
    expect(configs).toBe(1)
  })
})

describe('watchProject after files are replaced', () => {
  /** Applies `change`, waits for the event it must cause, then lets trailing events of the same change settle. */
  async function expectEvent(count: () => number, change: () => Promise<void>): Promise<void> {
    const before = count()
    await change()
    await waitFor(() => count() > before)
    await new Promise((r) => setTimeout(r, 150))
  }

  it('keeps reporting project.yaml and paper files after atomic replaces, in-place writes and git-style recreation', async () => {
    const root = await tmpDir()
    await mkdir(join(root, 'papers/he2017drain'), { recursive: true })
    await writeFile(join(root, 'project.yaml'), 'a')
    await writeFile(join(root, 'papers/he2017drain/extraction.yaml'), 'a')
    const papers = new Map<string, Set<string>>()
    let configs = 0
    let paperEvents = 0
    const stop = watchProject(
      root,
      {
        onPaper: (id, files) => {
          paperEvents++
          const seen = papers.get(id) ?? new Set<string>()
          for (const f of files) seen.add(f)
          papers.set(id, seen)
        },
        onConfig: () => configs++
      },
      30
    )
    try {
      await new Promise((r) => setTimeout(r, 100))
      const project = join(root, 'project.yaml')
      const extraction = join(root, 'papers/he2017drain/extraction.yaml')
      for (const [path, count] of [
        [project, () => configs],
        [extraction, () => paperEvents]
      ] as const) {
        await expectEvent(count, () => atomicWrite(path, 'app write'))
        await expectEvent(count, () => writeFile(path, 'external in place'))
        await expectEvent(count, async () => {
          await writeFile(`${path}.pull`, 'external replace')
          await rename(`${path}.pull`, path)
        })
        await expectEvent(count, async () => {
          await unlink(path)
          await writeFile(path, 'git checkout')
        })
        await expectEvent(count, () => writeFile(path, 'in place again'))
      }
      expect(papers.get('he2017drain')?.has('extraction.yaml')).toBe(true)

      // A paper folder that appears later is watched too, and its removal is reported.
      await expectEvent(
        () => papers.get('new2024paper')?.size ?? 0,
        async () => {
          await mkdir(join(root, 'papers/new2024paper'))
          await writeFile(join(root, 'papers/new2024paper/paper.yaml'), 'x')
        }
      )
      expect(papers.get('new2024paper')?.has('paper.yaml')).toBe(true)
      papers.delete('new2024paper')
      await expectEvent(
        () => (papers.get('new2024paper')?.has('paper.yaml') ? 1 : 0),
        () => atomicWrite(join(root, 'papers/new2024paper/paper.yaml'), 'y')
      )
      papers.delete('new2024paper')
      await expectEvent(
        () => papers.get('new2024paper')?.size ?? 0,
        () => rm(join(root, 'papers/new2024paper'), { recursive: true })
      )
      expect(papers.get('new2024paper')?.has('.')).toBe(true)
    } finally {
      stop()
    }
  })

  it('reports changes of relations.yaml at the root', async () => {
    const root = await tmpDir()
    let relations = 0
    let configs = 0
    const stop = watchProject(root, { onPaper: () => undefined, onConfig: () => configs++, onRelations: () => relations++ }, 50)
    await new Promise((r) => setTimeout(r, 100))
    await atomicWrite(join(root, 'relations.yaml'), 'schema_version: 1\n')
    await waitFor(() => relations > 0)
    await new Promise((r) => setTimeout(r, 150))
    stop()
    expect(relations).toBe(1)
    expect(configs).toBe(0)
  })

  it('reports folders moving in and out of .trash/', async () => {
    const root = await tmpDir()
    await mkdir(join(root, 'papers/he2017drain'), { recursive: true })
    let trash = 0
    const papers: string[] = []
    const stop = watchProject(root, { onPaper: (id) => papers.push(id), onConfig: () => undefined, onTrash: () => trash++ }, 50)
    await new Promise((r) => setTimeout(r, 100))
    await mkdir(join(root, '.trash'))
    await rename(join(root, 'papers/he2017drain'), join(root, '.trash/he2017drain'))
    await waitFor(() => trash > 0 && papers.includes('he2017drain'))
    await new Promise((r) => setTimeout(r, 150))
    // A file git writes into the trashed folder later (trashed.yaml, paper.yaml) is reported too.
    const beforeFile = trash
    await writeFile(join(root, '.trash/he2017drain/trashed.yaml'), 'x')
    await waitFor(() => trash > beforeFile)
    await new Promise((r) => setTimeout(r, 150))
    const before = trash
    await rename(join(root, '.trash/he2017drain'), join(root, 'papers/he2017drain'))
    await waitFor(() => trash > before)
    stop()
  })
})
