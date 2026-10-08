import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppController } from '../../src/main/AppController'
import type { ResearchEvent } from '../../src/shared/ipc'
import { tmpDir } from '../helpers/tmp'

async function controller(settingsFile: string, events: ResearchEvent[] = []): Promise<AppController> {
  const c = new AppController(settingsFile, (e) => events.push(e), { watch: false })
  await c.init()
  return c
}

describe('AppController', () => {
  it('creates a project, remembers it and reopens it on the next launch', async () => {
    const settingsFile = join(await tmpDir(), 'settings.json')
    const root = await tmpDir()
    const events: ResearchEvent[] = []
    const first = await controller(settingsFile, events)
    expect(first.projectInfo()).toBeNull()
    expect(await first.createProject(root, 'Thesis')).toEqual({ root, name: 'Thesis', contentLanguage: 'en', pdfPolicy: 'track' })
    expect(events).toContain('project-changed')
    await first.shutdown()

    const second = await controller(settingsFile)
    expect(second.projectInfo()?.root).toBe(root)
    await second.shutdown()
  })

  it('forgets a last project that no longer exists', async () => {
    const settingsFile = join(await tmpDir(), 'settings.json')
    const first = await controller(settingsFile)
    await first.setSettings({ lastProjectPath: join(await tmpDir(), 'gone') })
    const second = await controller(settingsFile)
    expect(second.projectInfo()).toBeNull()
    expect(second.getSettings().lastProjectPath).toBeNull()
  })

  it('tells the UI when project.yaml is edited outside the app', async () => {
    const events: ResearchEvent[] = []
    const c = new AppController(join(await tmpDir(), 'settings.json'), (e) => events.push(e))
    await c.init()
    const root = await tmpDir()
    await c.createProject(root, 'Thesis')
    events.length = 0
    const file = join(root, 'project.yaml')
    await writeFile(file, (await readFile(file, 'utf8')).replace(/^name: .*$/m, 'name: Renamed'))
    const start = Date.now()
    while (!events.includes('project-changed')) {
      if (Date.now() - start > 3000) throw new Error('no project-changed event')
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(c.projectInfo()?.name).toBe('Renamed')
    await c.shutdown()
  })

  it('updates project settings', async () => {
    const c = await controller(join(await tmpDir(), 'settings.json'))
    await c.createProject(await tmpDir(), 'Thesis')
    expect(await c.updateProject({ name: 'Tesis', contentLanguage: 'es', pdfPolicy: 'untracked' })).toMatchObject({ name: 'Tesis', contentLanguage: 'es', pdfPolicy: 'untracked' })
    await c.shutdown()
  })
})
