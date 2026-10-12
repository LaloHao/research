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
}

export const DEFAULT_SETTINGS: Omit<AppSettings, 'deviceId'> = {
  contactEmail: '',
  openalexApiKey: '',
  lastProjectPath: null,
  autoSync: true,
  autoSyncMinutes: AUTO_SYNC_MINUTES.default
}
