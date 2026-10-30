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

/** The window stays hidden at launch with `--hidden` or «Iniciar oculto en la bandeja» — but only with a tray to bring it back. */
export function startHidden(state: { argv: readonly string[]; setting: boolean; trayAvailable: boolean }): boolean {
  return state.trayAvailable && (state.setting || state.argv.includes(HIDDEN_FLAG))
}
