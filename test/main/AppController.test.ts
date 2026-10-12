import { describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppController } from '../../src/main/AppController'
import { toYaml } from '../../src/main/project/yamlFile'
import type { ResearchEvent } from '../../src/shared/ipc'
import type { ChatStreamUpdate } from '../../src/shared/chat'
import { renderChat } from '../../src/main/project/chatFile'
import { chatFile, CHAT_ID_A } from '../helpers/chats'
import { chatAnswer, FakeLlmProvider } from '../helpers/llm'
import { FakeEmbeddingRuntime } from '../helpers/embeddings'
import { newFacetSuggestion } from '../helpers/facets'
import { hangingRemote, processAlive, twoMachines } from '../helpers/git'
import { tmpDir } from '../helpers/tmp'

/** No automatic sync: these projects are not in an isolated repository, and git must never see the user's own config. */
async function controller(settingsFile: string, events: ResearchEvent[] = []): Promise<AppController> {
  const c = new AppController(settingsFile, (e) => events.push(e), { watch: false, autoSync: null })
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
    const c = new AppController(join(await tmpDir(), 'settings.json'), (e) => events.push(e), { autoSync: null })
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

  it('passes the OpenAlex API key to the open project and to the next one', async () => {
    const settingsFile = join(await tmpDir(), 'settings.json')
    const c = await controller(settingsFile)
    await c.setSettings({ openalexApiKey: 'k9' })
    await c.createProject(await tmpDir(), 'Thesis')
    expect(c.requireSession().http.politeUrl('https://api.openalex.org/works/W1')).toContain('api_key=k9')
    await c.setSettings({ openalexApiKey: '' })
    expect(c.requireSession().http.politeUrl('https://api.openalex.org/works/W1')).not.toContain('api_key')
    await c.shutdown()
  })

  it('reports and removes the local model', async () => {
    const runtime = new FakeEmbeddingRuntime(true)
    const c = new AppController(join(await tmpDir(), 'settings.json'), () => {}, { watch: false, embeddings: runtime, autoSync: null })
    await c.init()
    expect(await c.modelInfo()).toEqual({ modelId: 'fake-embedder', available: true, state: 'ready', sizeBytes: 1000, downloading: false })
    await c.removeModel()
    expect((await c.modelInfo()).state).toBe('missing')
    await c.shutdown()
    const plain = await controller(join(await tmpDir(), 'settings.json'))
    expect((await plain.modelInfo()).available).toBe(false)
    await plain.shutdown()
  })

  it('offers to sync before closing only for a project with a remote and something not synced', async () => {
    const m = await twoMachines()
    const c = new AppController(join(await tmpDir(), 'settings.json'), () => undefined, { watch: false, gitEnv: m.env, autoSync: null })
    await c.init()
    expect(await c.hasUnsyncedChanges()).toBe(false)
    await c.openProject(m.projectA)
    // Opening wrote the app's block in .gitignore.
    expect(await c.hasUnsyncedChanges()).toBe(true)
    expect(await c.requireSession().sync.run({ auto: false })).toEqual({ ok: true, outcome: 'synced' })
    expect(await c.hasUnsyncedChanges()).toBe(false)
    await c.createProject(await tmpDir(), 'Not in git')
    expect(await c.hasUnsyncedChanges()).toBe(false)
    await c.shutdown()
  })

  it('keeps the automatic sync settings across launches', async () => {
    const settingsFile = join(await tmpDir(), 'settings.json')
    const first = await controller(settingsFile)
    expect(first.getSettings()).toMatchObject({ autoSync: true, autoSyncMinutes: 10 })
    await first.setSettings({ autoSync: false, autoSyncMinutes: 30 })
    expect((await controller(settingsFile)).getSettings()).toMatchObject({ autoSync: false, autoSyncMinutes: 30 })
  })

  it('passes sync changes on to the window', async () => {
    const m = await twoMachines()
    const events: ResearchEvent[] = []
    const c = new AppController(join(await tmpDir(), 'settings.json'), (e) => events.push(e), { watch: false, gitEnv: m.env, autoSync: null })
    await c.init()
    await c.openProject(m.projectA)
    // The window learns the new project's sync status as soon as it opens, before any sync.
    expect(events).toContain('sync-changed')
    events.length = 0
    await c.requireSession().sync.run({ auto: false })
    expect(events).toContain('sync-changed')
    await c.shutdown()
  })

  it('reschedules the automatic sync only when its settings really change', async () => {
    const c = await controller(join(await tmpDir(), 'settings.json'))
    await c.createProject(await tmpDir(), 'Thesis')
    const reschedule = vi.spyOn(c.requireSession(), 'rescheduleSync')
    await c.setSettings({ autoSync: true, autoSyncMinutes: 10, contactEmail: 'me@uni.test' })
    expect(reschedule).not.toHaveBeenCalled()
    await c.setSettings({ autoSyncMinutes: 30 })
    expect(reschedule).toHaveBeenCalledTimes(1)
    await c.setSettings({ autoSync: false })
    expect(reschedule).toHaveBeenCalledTimes(2)
    await c.shutdown()
  })

  // git runs in its own process group and outlives the app unless it is stopped. Needs `sh`.
  it.skipIf(process.platform !== 'linux')('closing the project and quitting kill a sync that hangs on the network', async () => {
    const m = await twoMachines()
    const remote = await hangingRemote(m)
    const c = new AppController(join(await tmpDir(), 'settings.json'), () => undefined, { watch: false, gitEnv: remote.env })
    await c.init()
    const hung = async (count: number): Promise<number> => {
      const start = Date.now()
      while ((await remote.pids()).length < count) {
        if (Date.now() - start > 10_000) throw new Error('timed out')
        await new Promise((r) => setTimeout(r, 50))
      }
      return (await remote.pids())[count - 1]
    }
    const stopped = async (pid: number): Promise<void> => {
      const start = Date.now()
      while (processAlive(pid)) {
        if (Date.now() - start > 5_000) throw new Error(`git ${pid} still running`)
        await new Promise((r) => setTimeout(r, 50))
      }
    }

    try {
      // The automatic sync starts as the project opens.
      await c.openProject(m.projectA)
      const first = await hung(1)
      let started = Date.now()
      await c.closeProject()
      expect(Date.now() - started).toBeLessThan(5_000)
      await stopped(first)

      await c.openProject(m.projectA)
      const second = await hung(2)
      started = Date.now()
      await c.shutdown()
      expect(Date.now() - started).toBeLessThan(5_000)
      await stopped(second)
    } finally {
      // A failed assertion must leave neither an open project nor a sleeping fake ssh behind.
      await c.shutdown()
      await remote.kill()
    }
  })

  it('tells the UI when facet-suggestions.yaml changes outside the app', async () => {
    const events: ResearchEvent[] = []
    const c = new AppController(join(await tmpDir(), 'settings.json'), (e) => events.push(e), { autoSync: null })
    await c.init()
    const root = await tmpDir()
    await c.createProject(root, 'Thesis')
    events.length = 0
    await writeFile(join(root, 'facet-suggestions.yaml'), toYaml({ schema_version: 1, suggestions: [newFacetSuggestion()] }))
    const start = Date.now()
    while (!events.includes('facets-changed')) {
      if (Date.now() - start > 3000) throw new Error('no facets-changed event')
      await new Promise((r) => setTimeout(r, 20))
    }
    expect((await c.requireSession().facets.list()).pending).toBe(1)
    await c.shutdown()
  })

  it('streams chat answers to the window and tells it when chats/ changes outside the app', async () => {
    const events: ResearchEvent[] = []
    const updates: ChatStreamUpdate[] = []
    const llm = new FakeLlmProvider([], [], [chatAnswer('Hello there.')])
    const c = new AppController(join(await tmpDir(), 'settings.json'), (e) => events.push(e), { autoSync: null, llm }, (u) => updates.push(u))
    await c.init()
    const root = await tmpDir()
    await c.createProject(root, 'Thesis')
    const id = await c.requireSession().chats.send({ chatId: null, scope: 'library', model: 'sonnet', text: 'Hi', excerpt: null })
    await c.requireSession().chats.idle()
    expect(updates.map((u) => [u.chatId, u.kind]).at(-1)).toEqual([id, 'done'])
    expect(updates.some((u) => u.kind === 'delta')).toBe(true)
    expect(events).toContain('chats-changed')
    events.length = 0
    const other = CHAT_ID_A.replace('a1b2', 'ffff')
    await writeFile(join(root, 'chats', `${other}.md`), renderChat(chatFile(undefined, { id: other })))
    const start = Date.now()
    while (!events.includes('chats-changed')) {
      if (Date.now() - start > 3000) throw new Error('no chats-changed event')
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(c.requireSession().chats.list()).toHaveLength(2)
    await c.shutdown()
  })
})
