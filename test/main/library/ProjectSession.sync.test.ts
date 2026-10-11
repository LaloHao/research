import { describe, expect, it } from 'vitest'
import { ProjectSession } from '../../../src/main/library/ProjectSession'
import { routeFetch } from '../../helpers/fakeFetch'
import { hangingRemote, processAlive, twoMachines } from '../../helpers/git'

async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('ProjectSession sync', () => {
  it('syncs on its own when the project opens, tells about it, and stops when it closes', async () => {
    const m = await twoMachines()
    let events = 0
    const s = await ProjectSession.open(m.projectA, {
      contactEmail: '',
      fetch: routeFetch([]),
      watch: false,
      gitEnv: m.env,
      machineName: 'laptop',
      autoSync: { enabled: () => true, intervalMs: () => 3_600_000 }
    })
    s.on('sync', () => events++)
    // Opening wrote the app's block in .gitignore: the first automatic sync commits and pushes it.
    await waitFor(() => m.git(m.remote, 'log', '-1', '--format=%s', 'main') === 'research: sync from laptop')
    expect(m.git(m.remote, 'show', 'main:.gitignore')).toContain('.cache/')
    await waitFor(async () => (await s.sync.status()).lastSyncAt !== null)
    expect(events).toBeGreaterThan(0)
    await s.close()
  })

  it("commits through the store's write gate", async () => {
    const m = await twoMachines()
    const s = await ProjectSession.open(m.projectA, { contactEmail: '', fetch: routeFetch([]), watch: false, gitEnv: m.env, machineName: 'laptop' })
    let release!: () => void
    const held = s.store.exclusive(() => new Promise<void>((r) => (release = r)))
    let finished = false
    const run = s.sync.run({ auto: false }).then((result) => {
      finished = true
      return result
    })
    await new Promise((r) => setTimeout(r, 300))
    expect(finished).toBe(false)
    expect(m.git(m.a, 'log', '-1', '--format=%s')).toBe('init')
    release()
    await held
    expect(await run).toEqual({ ok: true, outcome: 'synced' })
    await s.close()
  })

  // git runs in its own process group, so it does not die with the app: closing has to stop it.
  it.skipIf(process.platform === 'win32')('closing cuts a hanging automatic sync short, kills its git and syncs no more', async () => {
    const m = await twoMachines()
    const remote = await hangingRemote(m)
    let events = 0
    const s = await ProjectSession.open(m.projectA, {
      contactEmail: '',
      fetch: routeFetch([]),
      watch: false,
      gitEnv: remote.env,
      machineName: 'laptop',
      autoSync: { enabled: () => true, intervalMs: () => 100 }
    })
    s.on('sync', () => events++)
    await waitFor(async () => (await remote.pids()).length > 0)
    const [pid] = await remote.pids()
    expect(processAlive(pid)).toBe(true)
    const started = Date.now()
    await s.close()
    expect(Date.now() - started).toBeLessThan(5_000)
    await waitFor(() => !processAlive(pid), 5_000)
    // The fetch was cut short; nothing reached the remote, and no sync starts once closed.
    expect(m.git(m.remote, 'log', '-1', '--format=%s', 'main')).toBe('init')
    expect(await s.sync.run({ auto: false })).toEqual({ ok: false, error: { code: 'cancelled', paths: [] } })
    const seen = events
    await new Promise((r) => setTimeout(r, 400))
    expect(events).toBe(seen)
    expect(await remote.pids()).toEqual([pid])
  })
})
