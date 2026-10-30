/**
 * What the window's ✕ does: `hide` keeps the app running in the tray (with the local API and the jobs); `close` goes
 * through the normal close flow, which quits. Hiding needs the tray to be there — otherwise the user would be left
 * with an invisible app — and never applies while a quit is under way (✕ then joins that quit's prompt).
 */
export function closeAction(state: { closeToTray: boolean; trayAvailable: boolean; quitting: boolean }): 'hide' | 'close' {
  return state.closeToTray && state.trayAvailable && !state.quitting ? 'hide' : 'close'
}

/** The flag that starts the app with its window hidden (e.g. from the session's autostart). */
export const HIDDEN_FLAG = '--hidden'

/**
 * The window stays hidden at launch with `--hidden` — but only with a tray to bring it back. «Iniciar oculto en la
 * bandeja» does not hide by itself: it puts the flag in the autostart entry, so a launch from the menu or a terminal
 * always shows the window.
 */
export function startHidden(state: { argv: readonly string[]; trayAvailable: boolean }): boolean {
  return state.trayAvailable && state.argv.includes(HIDDEN_FLAG)
}
