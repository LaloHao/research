import type { MenuItemConstructorOptions } from 'electron'
import { trayText } from './tray/strings'

/** What the application menu depends on; rebuilt when it changes (the tray may only appear after the panel starts). */
export interface AppMenuState {
  trayAvailable: boolean
  /** `pnpm dev`: «Recargar» too (a packaged build leaves it out: a reload would drop edits still in their autosave delay). */
  dev: boolean
}

export interface AppMenuActions {
  /** «Ocultar en la bandeja» (Ctrl+W), with the window that had the focus. */
  hideWindow: (focused: unknown) => void
  quit: () => void
}

/** Ctrl+W hides the window: for window managers without a close button (xmonad, tiling setups). */
export const HIDE_ACCELERATOR = 'CmdOrCtrl+W'
export const QUIT_ACCELERATOR = 'CmdOrCtrl+Q'

/**
 * The menu bar: Archivo (hide in the tray, quit), Editar (the clipboard shortcuts of text fields go through these
 * roles) and Ver (zoom, full screen, developer tools). Replaces Electron's English default menu.
 */
export function appMenuTemplate(state: AppMenuState, actions: AppMenuActions): MenuItemConstructorOptions[] {
  const text = (key: string): string => trayText(`tray.app_menu.${key}`)
  return [
    {
      label: text('file'),
      submenu: [
        // Without a tray there would be nothing to bring the window back: the item stays, disabled.
        { id: 'hide-to-tray', label: text('hide_to_tray'), accelerator: HIDE_ACCELERATOR, enabled: state.trayAvailable, click: (_item, win) => actions.hideWindow(win) },
        { type: 'separator' },
        { id: 'quit', label: text('quit'), accelerator: QUIT_ACCELERATOR, click: () => actions.quit() }
      ]
    },
    {
      label: text('edit'),
      submenu: [
        { role: 'undo', label: text('undo') },
        { role: 'redo', label: text('redo') },
        { type: 'separator' },
        { role: 'cut', label: text('cut') },
        { role: 'copy', label: text('copy') },
        { role: 'paste', label: text('paste') },
        { role: 'selectAll', label: text('select_all') }
      ]
    },
    {
      label: text('view'),
      submenu: [
        ...(state.dev ? [{ role: 'reload', label: text('reload') } as const] : []),
        { role: 'toggleDevTools', label: text('dev_tools') },
        { type: 'separator' },
        { role: 'resetZoom', label: text('reset_zoom') },
        { role: 'zoomIn', label: text('zoom_in') },
        { role: 'zoomOut', label: text('zoom_out') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: text('fullscreen') }
      ]
    }
  ]
}

/**
 * What «Ocultar en la bandeja» does with the window that had the focus: the main window goes to the tray (the app keeps
 * running, as with ✕ and «seguir en la bandeja»); another window (the app's browser) just closes; nothing without a tray.
 */
export function hideAction(state: { trayAvailable: boolean; focusedIsMain: boolean; hasFocused: boolean }): 'hide-main' | 'close-focused' | 'none' {
  if (!state.trayAvailable) return 'none'
  if (state.hasFocused && !state.focusedIsMain) return 'close-focused'
  return 'hide-main'
}
