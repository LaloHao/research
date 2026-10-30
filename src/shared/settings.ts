import type { CapturePdfMode } from './capture'
import { DEFAULT_API_PORT } from './localApi'
import { AUTO_SYNC_MINUTES } from './sync'

/** Per-user settings stored in the app's userData, never in a project folder. */
export interface AppSettings {
  /** Sent to Crossref/OpenAlex only when the user sets it. */
  contactEmail: string
  /** Optional OpenAlex API key (raises the daily budget); sent only to api.openalex.org. */
  openalexApiKey: string
  lastProjectPath: string | null
  /** Identifies this computer in costs/<device-id>.jsonl; generated once. */
  deviceId: string
  /** Sync the open project with git on its own: when it opens and every `autoSyncMinutes` (this device only). */
  autoSync: boolean
  autoSyncMinutes: number
  /** The local API (MCP over HTTP on 127.0.0.1) for editors such as Emacs; off by default. */
  apiEnabled: boolean
  apiPort: number
  /** Lets the local API run operations that spend Claude quota (each still asks for confirmation); off by default. */
  apiAllowCostly: boolean
  /** How the app's browser makes a page's PDF (its toolbar sets it): the reader view by default. */
  capturePdfMode: CapturePdfMode
  /** «Al cerrar la ventana, seguir en la bandeja»: closing the window hides it while the tray is there; on by default. */
  closeToTray: boolean
  /** «Iniciar oculto en la bandeja»: the window stays hidden at launch (also with `--hidden`) while the tray is there. */
  startHidden: boolean
  /** The one-time «research sigue en la bandeja» was shown; set by the main process only. */
  trayHintShown: boolean
}

export const DEFAULT_SETTINGS: Omit<AppSettings, 'deviceId'> = {
  contactEmail: '',
  openalexApiKey: '',
  lastProjectPath: null,
  autoSync: true,
  autoSyncMinutes: AUTO_SYNC_MINUTES.default,
  apiEnabled: false,
  apiPort: DEFAULT_API_PORT,
  apiAllowCostly: false,
  capturePdfMode: 'reader',
  closeToTray: true,
  startHidden: false,
  trayHintShown: false
}
