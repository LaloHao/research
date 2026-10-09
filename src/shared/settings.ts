/** Per-user settings stored in the app's userData, never in a project folder. */
export interface AppSettings {
  /** Sent to Crossref/OpenAlex only when the user sets it. */
  contactEmail: string
  lastProjectPath: string | null
  /** Identifies this computer in costs/<device-id>.jsonl; generated once. */
  deviceId: string
}

export const DEFAULT_SETTINGS: Omit<AppSettings, 'deviceId'> = { contactEmail: '', lastProjectPath: null }
