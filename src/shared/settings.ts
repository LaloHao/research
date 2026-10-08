/** Per-user settings stored in the app's userData, never in a project folder. */
export interface AppSettings {
  /** Sent to Crossref/OpenAlex only when the user sets it. */
  contactEmail: string
  lastProjectPath: string | null
}

export const DEFAULT_SETTINGS: AppSettings = { contactEmail: '', lastProjectPath: null }
