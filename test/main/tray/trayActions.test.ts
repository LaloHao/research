import { describe, expect, it } from 'vitest'
import type { SyncResult, SyncStatus } from '../../../src/shared/sync'
import { runTrayAction, syncFromTray, type TrayActionDeps } from '../../../src/main/tray/trayActions'

const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  setup: 'ready',
  phase: 'idle',
  lastSyncAt: null,
  dirty: true,
  ahead: 0,
  error: null,
  errorAuto: false,
  conflicts: 0,
  repoRoot: '/home/me/thesis',
  branch: 'main',
  upstream: 'origin/main',
  ...over
})

function fakeDeps(over: Partial<TrayActionDeps> = {}): { deps: TrayActionDeps; calls: string[] } {
  const calls: string[] = []
  const deps: TrayActionDeps = {
    toggleWindow: () => calls.push('toggle'),
    readClipboard: () => '10.1109/ICWS.2017.13',
    hasProject: () => true,
    addIdentifier: (input) => calls.push(`add ${input}`),
    openInAppBrowser: (url) => calls.push(`browse ${url}`),
    syncStatus: async () => status(),
    runSync: async () => {
      calls.push('sync')
      return { ok: true, outcome: 'synced' }
    },
    openSyncView: () => calls.push('open-sync'),
    toggleApi: async () => void calls.push('api'),
    openProject: async () => void calls.push('open-project'),
    quit: () => calls.push('quit'),
    notify: (body) => calls.push(`notify ${body}`),
    ...over
  }
  return { deps, calls }
}

describe('tray actions', () => {
  it('adds a DOI from the clipboard as a queued job', async () => {
    const { deps, calls } = fakeDeps()
    await runTrayAction('add-clipboard', deps)
    expect(calls).toEqual(['add 10.1109/ICWS.2017.13', 'notify Se agregó a la cola: lo verás en Actividad.'])
  })

  it('says so when the clipboard has nothing to add or open, without repeating it', async () => {
    const { deps, calls } = fakeDeps({ readClipboard: () => 'my secret notes' })
    await runTrayAction('add-clipboard', deps)
    await runTrayAction('browse-clipboard', deps)
    expect(calls).toEqual(['notify El portapapeles no tiene un DOI, arXiv o URL', 'notify El portapapeles no tiene una URL http(s)'])
    expect(calls.join(' ')).not.toContain('secret')
  })

  it('opens an http(s) address from the clipboard in the app browser', async () => {
    const { deps, calls } = fakeDeps({ readClipboard: () => 'https://example.org/a' })
    await runTrayAction('browse-clipboard', deps)
    expect(calls).toEqual(['browse https://example.org/a'])
  })

  it('needs a project for the clipboard and does not read it without one', async () => {
    let read = false
    const { deps, calls } = fakeDeps({
      hasProject: () => false,
      readClipboard: () => {
        read = true
        return ''
      }
    })
    await runTrayAction('add-clipboard', deps)
    await runTrayAction('sync-now', deps)
    expect(read).toBe(false)
    expect(calls).toEqual(['notify Abre un proyecto primero.'])
  })

  it('passes the window toggle, the API switch, open project and quit through', async () => {
    const { deps, calls } = fakeDeps()
    for (const id of ['toggle-window', 'toggle-api', 'open-project', 'quit'] as const) await runTrayAction(id, deps)
    expect(calls).toEqual(['toggle', 'api', 'open-project', 'quit'])
  })
})

describe('«Sincronizar ahora» from the tray', () => {
  const run = async (s: SyncStatus | Error, result: SyncResult | Error = { ok: true, outcome: 'synced' }): Promise<string[]> => {
    const { deps, calls } = fakeDeps({
      syncStatus: async () => {
        if (s instanceof Error) throw s
        return s
      },
      runSync: async () => {
        calls.push('sync')
        if (result instanceof Error) throw result
        return result
      }
    })
    await syncFromTray(deps)
    return calls
  }

  it('syncs right away when the rail would', async () => {
    expect(await run(status())).toEqual(['sync'])
  })

  it('opens the Sync view when the sync ends in conflicts or fails', async () => {
    expect(await run(status(), { ok: true, outcome: 'conflicts' })).toEqual(['sync', 'open-sync'])
    expect(await run(status(), { ok: false, error: { code: 'offline', message: '', paths: [] } } as SyncResult)).toEqual(['sync', 'open-sync'])
    expect(await run(status(), new Error('git'))).toEqual(['sync', 'open-sync'])
  })

  it('opens the Sync view instead of syncing when something is missing, as the rail does', async () => {
    expect(await run(status({ setup: 'no_remote' }))).toEqual(['open-sync'])
    expect(await run(status({ conflicts: 2 }))).toEqual(['open-sync'])
    expect(await run(new Error('status'))).toEqual(['open-sync'])
  })

  it('does nothing while a sync runs', async () => {
    expect(await run(status({ phase: 'syncing' }))).toEqual([])
  })
})
