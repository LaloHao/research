import type { MenuItemConstructorOptions } from 'electron'
import { FailureWatch, trayMenu, trayTooltip, trayVariant, type TrayActionId, type TrayItem, type TraySync, type TrayVariant } from './trayModel'

/** The parts of Electron's `Tray` the controller uses. */
export interface TrayLike {
  setImage(image: unknown): void
  setToolTip(text: string): void
  setContextMenu(menu: unknown): void
  on(event: 'click', listener: () => void): unknown
  destroy(): void
}

/** The app's state the tray shows, read on each refresh. */
export interface TraySnapshot {
  windowVisible: boolean
  /** The window is visible and focused: failures listed now count as seen. */
  looking: boolean
  /** Identifies the open project (its folder), so a switch starts the failures over; null without one. */
  projectRoot: string | null
  projectName: string | null
  sync: TraySync | null
  conflicts: number
  jobsActive: number
  failedJobIds: number[]
  apiEnabled: boolean | null
}

export interface TrayControllerDeps {
  /** Creates the tray icon with its first image; throws when the platform has none. */
  createTray(image: unknown): TrayLike
  /** `Menu.buildFromTemplate`. */
  buildMenu(template: MenuItemConstructorOptions[]): unknown
  icon(variant: TrayVariant): unknown
  snapshot(): Promise<TraySnapshot>
  act(id: TrayActionId): void
  /** Waits between a change and the refresh it causes, so a burst of job updates rebuilds the menu once. */
  debounceMs?: number
}

/** Electron's menu template for the tray's menu model. */
export function menuTemplate(items: TrayItem[], act: (id: TrayActionId) => void): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    switch (item.kind) {
      case 'separator':
        return { type: 'separator' }
      case 'label':
        return { label: item.label, enabled: false }
      case 'checkbox':
        return { type: 'checkbox', label: item.label, checked: item.checked, click: () => act(item.id) }
      case 'action':
        return { label: item.label, enabled: item.enabled, click: () => act(item.id) }
    }
  })
}

/**
 * The tray icon: its image (plain, busy, attention), tooltip and context menu follow the app's state. Left click
 * shows or hides the window. `available()` is false until the icon exists (and for good if it could not be created),
 * which is what keeps closing the window from hiding the app with nowhere to bring it back from.
 */
export class TrayController {
  private tray: TrayLike | null = null
  private readonly failures = new FailureWatch()
  private projectRoot: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private dueAt = 0
  private variant: TrayVariant | null = null
  private rendering: Promise<void> | null = null
  private again = false
  /** Until then the tooltip keeps a message from `say`. */
  private sayingUntil = 0

  constructor(private readonly deps: TrayControllerDeps) {}

  /** Creates the icon; false (and logged by the caller) when the platform refuses it. */
  create(): boolean {
    if (this.tray) return true
    try {
      this.tray = this.deps.createTray(this.deps.icon('normal'))
    } catch {
      this.tray = null
      return false
    }
    this.variant = 'normal'
    this.tray.on('click', () => this.deps.act('toggle-window'))
    this.refresh(0)
    return true
  }

  available(): boolean {
    return this.tray !== null
  }

  /**
   * Schedules a refresh. A refresh already due sooner covers this one, so a stream of job progress updates refreshes
   * every `delay` instead of postponing the refresh forever.
   */
  refresh(delay = this.deps.debounceMs ?? 400): void {
    if (!this.tray) return
    const due = Date.now() + delay
    if (this.timer && this.dueAt <= due) return
    if (this.timer) clearTimeout(this.timer)
    this.dueAt = due
    this.timer = setTimeout(() => {
      this.timer = null
      void this.render()
    }, delay)
  }

  /** Rebuilds the icon, tooltip and menu now; a call while one runs makes it run once more afterwards. */
  render(): Promise<void> {
    if (this.rendering) {
      this.again = true
      return this.rendering
    }
    this.rendering = this.renderOnce()
      .catch((error: unknown) => console.error('tray', error))
      .finally(() => {
        this.rendering = null
        if (this.again) {
          this.again = false
          void this.render()
        }
      })
    return this.rendering
  }

  /** Shows `text` as the tooltip for a few seconds (where the desktop has no notifications). */
  say(text: string, ms = 6000): void {
    if (!this.tray) return
    this.tray.setToolTip(text)
    this.sayingUntil = Date.now() + ms
    // Puts the status back once the message has had its time (other refreshes meanwhile leave the message alone).
    setTimeout(() => this.refresh(0), ms).unref?.()
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.tray?.destroy()
    this.tray = null
  }

  private async renderOnce(): Promise<void> {
    const snap = await this.deps.snapshot()
    const tray = this.tray
    if (!tray) return
    if (snap.projectRoot !== this.projectRoot) {
      this.projectRoot = snap.projectRoot
      this.failures.reset()
    }
    const unseenFailures = this.failures.update(snap.failedJobIds, snap.looking)
    const state = {
      windowVisible: snap.windowVisible,
      projectName: snap.projectName,
      sync: snap.sync,
      jobsActive: snap.jobsActive,
      unseenFailures,
      apiEnabled: snap.apiEnabled
    }
    const variant = trayVariant({ jobsActive: snap.jobsActive, conflicts: snap.conflicts, unseenFailures })
    if (variant !== this.variant) {
      tray.setImage(this.deps.icon(variant))
      this.variant = variant
    }
    if (Date.now() >= this.sayingUntil) tray.setToolTip(trayTooltip(state))
    tray.setContextMenu(this.deps.buildMenu(menuTemplate(trayMenu(state), (id) => this.deps.act(id))))
  }
}
