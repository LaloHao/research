import { describe, expect, it } from 'vitest'
import { canSyncNow, FailureWatch, trayMenu, trayTooltip, trayVariant, type TrayItem, type TrayState, type TraySync } from '../../../src/main/tray/trayModel'

const synced: TraySync = { indicator: { state: 'minutes', tone: 'ok', count: 5 }, action: 'sync' }
const state = (over: Partial<TrayState> = {}): TrayState => ({
  windowVisible: true,
  projectName: 'Tesis',
  sync: synced,
  jobsActive: 0,
  unseenFailures: 0,
  apiEnabled: false,
  ...over
})
const labels = (items: TrayItem[]): string[] => items.map((i) => (i.kind === 'separator' ? '—' : i.label))
const find = (items: TrayItem[], id: string): TrayItem | undefined => items.find((i) => (i.kind === 'action' || i.kind === 'checkbox') && i.id === id)

describe('tray icon variant', () => {
  it('shows attention for conflicts or unseen failures, busy while jobs run, plain otherwise', () => {
    expect(trayVariant({ jobsActive: 0, conflicts: 0, unseenFailures: 0 })).toBe('normal')
    expect(trayVariant({ jobsActive: 3, conflicts: 0, unseenFailures: 0 })).toBe('busy')
    expect(trayVariant({ jobsActive: 3, conflicts: 1, unseenFailures: 0 })).toBe('attention')
    expect(trayVariant({ jobsActive: 0, conflicts: 0, unseenFailures: 2 })).toBe('attention')
  })
})

describe('unseen failures', () => {
  it('counts the failures from before the first look as seen', () => {
    const watch = new FailureWatch()
    expect(watch.update([1, 2], false)).toBe(0)
    expect(watch.update([1, 2, 5], false)).toBe(1)
    expect(watch.update([1, 2, 5, 6], false)).toBe(2)
  })

  it('marks every failure as seen once the window is looked at', () => {
    const watch = new FailureWatch()
    watch.update([], false)
    expect(watch.update([7], false)).toBe(1)
    expect(watch.update([7], true)).toBe(0)
    expect(watch.update([7], false)).toBe(0)
    expect(watch.update([7, 8], false)).toBe(1)
  })

  it('starts over after a reset (another project)', () => {
    const watch = new FailureWatch()
    watch.update([], false)
    expect(watch.update([3], false)).toBe(1)
    watch.reset()
    expect(watch.update([3, 4], false)).toBe(0)
  })
})

describe('tray menu', () => {
  it('lists the window toggle, the project, the clipboard, the sync, the API, open project and quit', () => {
    expect(labels(trayMenu(state()))).toEqual([
      'Ocultar ventana',
      '—',
      'Proyecto: Tesis',
      'Agregar desde el portapapeles',
      'Abrir en el navegador de la app',
      '—',
      'Sincronización: Sincronizado hace 5 min',
      'Sincronizar ahora',
      '—',
      'API local: apagada',
      'Abrir proyecto…',
      '—',
      'Salir'
    ])
  })

  it('says «Mostrar ventana» while the window is hidden', () => {
    expect(find(trayMenu(state({ windowVisible: false })), 'toggle-window')).toMatchObject({ label: 'Mostrar ventana', enabled: true })
  })

  it('shows the jobs in progress and the unseen failures only when there are some', () => {
    expect(labels(trayMenu(state({ jobsActive: 1 })))).toContain('1 trabajo en curso')
    expect(labels(trayMenu(state({ jobsActive: 4, unseenFailures: 2 })))).toEqual(expect.arrayContaining(['4 trabajos en curso', '2 trabajos fallaron']))
    expect(labels(trayMenu(state())).some((l) => l.includes('trabajo'))).toBe(false)
  })

  it('checks «API local» when it is on, and leaves it out when the app has no API', () => {
    expect(find(trayMenu(state({ apiEnabled: true })), 'toggle-api')).toEqual({ kind: 'checkbox', id: 'toggle-api', label: 'API local: encendida', checked: true })
    expect(find(trayMenu(state({ apiEnabled: null })), 'toggle-api')).toBeUndefined()
  })

  it('disables the project actions and leaves out the sync without a project', () => {
    const items = trayMenu(state({ projectName: null, sync: null }))
    expect(labels(items)).toContain('Sin proyecto abierto')
    expect(find(items, 'add-clipboard')).toMatchObject({ enabled: false })
    expect(find(items, 'browse-clipboard')).toMatchObject({ enabled: false })
    expect(find(items, 'sync-now')).toBeUndefined()
    expect(find(items, 'open-project')).toMatchObject({ enabled: true })
    expect(find(items, 'quit')).toMatchObject({ enabled: true })
  })

  it('disables «Sincronizar ahora» without a repository or while a sync runs', () => {
    const sync = (state: TraySync['indicator']['state'], action: TraySync['action']): TraySync => ({ indicator: { state, tone: 'off', count: 0 }, action })
    expect(canSyncNow(sync('no_repo', 'open'))).toBe(false)
    expect(canSyncNow(sync('no_git', 'open'))).toBe(false)
    expect(canSyncNow(sync('syncing', 'none'))).toBe(false)
    expect(canSyncNow(null)).toBe(false)
    // These open the Sync view, which explains what is missing.
    expect(canSyncNow(sync('no_remote', 'open'))).toBe(true)
    expect(canSyncNow(sync('conflicts', 'open'))).toBe(true)
    expect(canSyncNow(sync('pending', 'sync'))).toBe(true)
    expect(find(trayMenu(state({ sync: sync('no_repo', 'open') })), 'sync-now')).toMatchObject({ enabled: false })
  })
})

describe('tray tooltip', () => {
  it('names the app, the project, the sync, the jobs and the API', () => {
    expect(trayTooltip(state({ jobsActive: 2, apiEnabled: true }))).toBe(
      'research\nProyecto: Tesis\nSincronización: Sincronizado hace 5 min\n2 trabajos en curso\nAPI local: encendida'
    )
    expect(trayTooltip(state({ projectName: null, sync: null, apiEnabled: null }))).toBe('research\nSin proyecto abierto')
  })
})
