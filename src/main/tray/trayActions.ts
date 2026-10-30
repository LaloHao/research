import type { SyncResult, SyncStatus } from '../../shared/sync'
import { railAction } from '../../shared/syncIndicator'
import { clipboardAction } from './clipboardAction'
import { trayText } from './strings'
import type { TrayActionId } from './trayModel'

/** What the tray's menu items do, as the app provides it (Electron stays outside, so this can be tested). */
export interface TrayActionDeps {
  toggleWindow(): void
  /** The clipboard's text; never logged, and used only to add or open it here. */
  readClipboard(): string
  hasProject(): boolean
  /** The «Agregar» box's flow: a queued `ingest_identifier` job, shown in Actividad. */
  addIdentifier(input: string): void
  /** «Abrir en el navegador de la app». */
  openInAppBrowser(url: string): void
  syncStatus(): Promise<SyncStatus>
  runSync(): Promise<SyncResult>
  /** Shows the window on the Sync view, which explains a conflict, an error or what is missing. */
  openSyncView(): void
  /** Turns the local API on or off, as Settings does. */
  toggleApi(): Promise<void>
  /** The app's «Abrir proyecto…» (folder picker). */
  openProject(): Promise<void>
  /** Quits through the normal close flow (pending edits, «Hay cambios sin sincronizar», jobs and sync stopped). */
  quit(): void
  /** A desktop notification (or whatever stands in for one). */
  notify(body: string): void
}

/**
 * The tray's «Sincronizar ahora», as the rail's button: it syncs right away when it can; when it cannot (no remote,
 * conflicts, an error) or the sync ends in conflicts or fails, the window opens on the Sync view.
 */
export async function syncFromTray(deps: Pick<TrayActionDeps, 'syncStatus' | 'runSync' | 'openSyncView'>): Promise<void> {
  const status = await deps.syncStatus().catch(() => 'failed' as const)
  const action = railAction(status)
  if (action === 'none') return
  if (action === 'open') {
    deps.openSyncView()
    return
  }
  const result = await deps.runSync().catch(() => null)
  if (!result || !result.ok || result.outcome === 'conflicts') deps.openSyncView()
}

/** Runs one of the tray's menu items. */
export async function runTrayAction(id: TrayActionId, deps: TrayActionDeps): Promise<void> {
  switch (id) {
    case 'toggle-window':
      deps.toggleWindow()
      return
    case 'add-clipboard':
    case 'browse-clipboard': {
      if (!deps.hasProject()) {
        deps.notify(trayText('tray.notify.no_project'))
        return
      }
      const browse = id === 'browse-clipboard'
      const action = clipboardAction(deps.readClipboard(), browse ? 'browse' : 'add')
      if (action.kind === 'add') {
        deps.addIdentifier(action.input)
        deps.notify(trayText('tray.notify.added'))
      } else if (action.kind === 'browse') {
        deps.openInAppBrowser(action.url)
      } else {
        deps.notify(trayText(browse ? 'tray.notify.no_url' : 'tray.notify.no_identifier'))
      }
      return
    }
    case 'sync-now':
      if (deps.hasProject()) await syncFromTray(deps)
      return
    case 'toggle-api':
      await deps.toggleApi()
      return
    case 'open-project':
      await deps.openProject()
      return
    case 'quit':
      deps.quit()
      return
  }
}
