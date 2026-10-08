import { readFile } from 'node:fs/promises'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/settings'
import { atomicWrite } from './project/atomicWrite'

export async function loadSettings(file: string): Promise<AppSettings> {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  return {
    contactEmail: typeof raw.contactEmail === 'string' ? raw.contactEmail : DEFAULT_SETTINGS.contactEmail,
    lastProjectPath: typeof raw.lastProjectPath === 'string' ? raw.lastProjectPath : DEFAULT_SETTINGS.lastProjectPath
  }
}

export async function saveSettings(file: string, settings: AppSettings): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(settings, null, 2)}\n`)
}
