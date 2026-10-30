/** «Iniciar con la sesión» (Settings → Aplicación): an XDG autostart entry, Linux only. */
export interface AutostartStatus {
  /** The platform has XDG autostart (Linux). */
  supported: boolean
  /** A packaged build: the entry launches its executable. In development there is nothing stable to launch. */
  packaged: boolean
  /** The entry exists. */
  enabled: boolean
  /** The entry's path, e.g. ~/.config/autostart/research.desktop. */
  file: string | null
  /** In development: a command line the user may add to the session's autostart themselves (after `pnpm build`). */
  devCommand: string | null
}

/** What Settings → Aplicación shows about the tray and the session start. */
export interface DesktopStatus {
  /** The tray icon is there: closing the window hides it (with «Al cerrar la ventana, seguir en la bandeja»). */
  trayAvailable: boolean
  autostart: AutostartStatus
}
