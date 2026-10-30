import type { SyncIndicator } from '../../shared/syncIndicator'
import { trayText } from './strings'

/** The tray icon: the plain book, with an amber dot while jobs run, or a red one when something needs a look. */
export type TrayVariant = 'normal' | 'busy' | 'attention'

/**
 * `attention` (red dot) wins: sync conflicts waiting for a decision, or jobs that failed since the user last looked at
 * the window. Otherwise `busy` (amber dot) while jobs are queued or running; else the plain icon.
 */
export function trayVariant(state: { jobsActive: number; conflicts: number; unseenFailures: number }): TrayVariant {
  if (state.conflicts > 0 || state.unseenFailures > 0) return 'attention'
  return state.jobsActive > 0 ? 'busy' : 'normal'
}

/**
 * Which failed jobs the user has not seen yet. A failure counts as seen once the window was shown and focused after
 * it happened; the failures already there when the tray first looks (previous sessions, another project) count as seen.
 */
export class FailureWatch {
  private seen: Set<number> | null = null

  /** The failed job ids now; `looking`: the window is visible and focused. Returns how many are unseen. */
  update(failedIds: readonly number[], looking: boolean): number {
    if (this.seen === null || looking) {
      this.seen = new Set(failedIds)
      return 0
    }
    return failedIds.filter((id) => !this.seen!.has(id)).length
  }

  /** A project switch starts over: the new project's old failures are not news. */
  reset(): void {
    this.seen = null
  }
}

/** The sync part of the tray: the rail's indicator and what its button would do. */
export interface TraySync {
  indicator: SyncIndicator
  /** `railAction`: sync right away, open the Sync view (which explains what is missing), or nothing (busy). */
  action: 'sync' | 'open' | 'none'
}

/** Everything the menu and the tooltip show; built from the app's state on each refresh. */
export interface TrayState {
  windowVisible: boolean
  projectName: string | null
  /** Null without a project, or before the first status arrived. */
  sync: TraySync | null
  /** Queued and running jobs. */
  jobsActive: number
  unseenFailures: number
  /** Null when the app runs without the local API. */
  apiEnabled: boolean | null
}

export type TrayActionId = 'toggle-window' | 'add-clipboard' | 'browse-clipboard' | 'sync-now' | 'toggle-api' | 'open-project' | 'quit'

export type TrayItem =
  | { kind: 'action'; id: TrayActionId; label: string; enabled: boolean }
  | { kind: 'checkbox'; id: TrayActionId; label: string; checked: boolean }
  | { kind: 'label'; label: string }
  | { kind: 'separator' }

/** Sync states with no repository to sync: «Sincronizar ahora» is disabled (the Sync view sets one up). */
const NO_REPO = new Set(['no_git', 'no_repo'])

/** Whether «Sincronizar ahora» can do something: run the sync, or open the Sync view to explain why it cannot. */
export function canSyncNow(sync: TraySync | null): boolean {
  return sync !== null && sync.action !== 'none' && !NO_REPO.has(sync.indicator.state)
}

function syncStatusText(sync: TraySync): string {
  return trayText(`sync.status.${sync.indicator.state}`, { count: sync.indicator.count })
}

/** The context menu, top to bottom. */
export function trayMenu(state: TrayState): TrayItem[] {
  const hasProject = state.projectName !== null
  const items: TrayItem[] = [
    { kind: 'action', id: 'toggle-window', label: trayText(state.windowVisible ? 'tray.hide' : 'tray.show'), enabled: true },
    { kind: 'separator' },
    { kind: 'label', label: hasProject ? trayText('tray.project', { name: state.projectName! }) : trayText('tray.no_project') },
    { kind: 'action', id: 'add-clipboard', label: trayText('tray.add_clipboard'), enabled: hasProject },
    { kind: 'action', id: 'browse-clipboard', label: trayText('tray.browse_clipboard'), enabled: hasProject }
  ]
  if (hasProject) {
    items.push({ kind: 'separator' })
    if (state.sync) items.push({ kind: 'label', label: trayText('tray.sync_line', { status: syncStatusText(state.sync) }) })
    items.push({ kind: 'action', id: 'sync-now', label: trayText('tray.sync_now'), enabled: canSyncNow(state.sync) })
    if (state.jobsActive > 0) items.push({ kind: 'label', label: trayText('tray.jobs', { count: state.jobsActive }) })
    if (state.unseenFailures > 0) items.push({ kind: 'label', label: trayText('tray.failed', { count: state.unseenFailures }) })
  }
  items.push({ kind: 'separator' })
  if (state.apiEnabled !== null) {
    items.push({ kind: 'checkbox', id: 'toggle-api', label: trayText(state.apiEnabled ? 'tray.api_on' : 'tray.api_off'), checked: state.apiEnabled })
  }
  items.push({ kind: 'action', id: 'open-project', label: trayText('tray.open_project'), enabled: true })
  items.push({ kind: 'separator' }, { kind: 'action', id: 'quit', label: trayText('tray.quit'), enabled: true })
  return items
}

/** The tooltip: the app's name, then one line each for the project, the sync, the jobs and the local API. */
export function trayTooltip(state: TrayState): string {
  const lines = ['research', state.projectName !== null ? trayText('tray.project', { name: state.projectName }) : trayText('tray.no_project')]
  if (state.projectName !== null && state.sync) lines.push(trayText('tray.sync_line', { status: syncStatusText(state.sync) }))
  if (state.jobsActive > 0) lines.push(trayText('tray.jobs', { count: state.jobsActive }))
  if (state.unseenFailures > 0) lines.push(trayText('tray.failed', { count: state.unseenFailures }))
  if (state.apiEnabled !== null) lines.push(trayText(state.apiEnabled ? 'tray.api_on' : 'tray.api_off'))
  return lines.join('\n')
}
