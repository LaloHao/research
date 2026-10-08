import { describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
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
    let configs = 0
    const stop = watchProject(root, { onPaper: (id) => papers.push(id), onConfig: () => configs++ }, 50)
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
    expect(configs).toBe(1)
  })
})
