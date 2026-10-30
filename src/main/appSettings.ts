import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isCapturePdfMode } from '../shared/capture'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/settings'
import { API_PORTS } from '../shared/localApi'
import { AUTO_SYNC_MINUTES } from '../shared/sync'
import { atomicWrite } from './project/atomicWrite'

const DEVICE_ID = /^[0-9a-f-]{36}$/

const validMinutes = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= AUTO_SYNC_MINUTES.min && value <= AUTO_SYNC_MINUTES.max

const validPort = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= API_PORTS.min && value <= API_PORTS.max

const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

export async function loadSettings(file: string): Promise<AppSettings> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    parsed = null
  }
  const raw = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  return {
    contactEmail: typeof raw.contactEmail === 'string' ? raw.contactEmail : DEFAULT_SETTINGS.contactEmail,
    openalexApiKey: typeof raw.openalexApiKey === 'string' ? raw.openalexApiKey : DEFAULT_SETTINGS.openalexApiKey,
    lastProjectPath: typeof raw.lastProjectPath === 'string' ? raw.lastProjectPath : DEFAULT_SETTINGS.lastProjectPath,
    deviceId: typeof raw.deviceId === 'string' && DEVICE_ID.test(raw.deviceId) ? raw.deviceId : randomUUID(),
    autoSync: typeof raw.autoSync === 'boolean' ? raw.autoSync : DEFAULT_SETTINGS.autoSync,
    autoSyncMinutes: validMinutes(raw.autoSyncMinutes) ? raw.autoSyncMinutes : DEFAULT_SETTINGS.autoSyncMinutes,
    apiEnabled: typeof raw.apiEnabled === 'boolean' ? raw.apiEnabled : DEFAULT_SETTINGS.apiEnabled,
    apiPort: validPort(raw.apiPort) ? raw.apiPort : DEFAULT_SETTINGS.apiPort,
    apiAllowCostly: typeof raw.apiAllowCostly === 'boolean' ? raw.apiAllowCostly : DEFAULT_SETTINGS.apiAllowCostly,
    capturePdfMode: isCapturePdfMode(raw.capturePdfMode) ? raw.capturePdfMode : DEFAULT_SETTINGS.capturePdfMode,
    closeToTray: flag(raw.closeToTray, DEFAULT_SETTINGS.closeToTray),
    startHidden: flag(raw.startHidden, DEFAULT_SETTINGS.startHidden),
    trayHintShown: flag(raw.trayHintShown, DEFAULT_SETTINGS.trayHintShown)
  }
}

export async function saveSettings(file: string, settings: AppSettings): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(settings, null, 2)}\n`)
}
