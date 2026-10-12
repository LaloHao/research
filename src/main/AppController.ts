import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectInfo, ResearchEvent } from '../shared/ipc'
import type { ModelInfo } from '../shared/relations'
import type { PdfPolicy } from '../shared/schemas'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/settings'
import { loadSettings, saveSettings } from './appSettings'
import { ProjectSession, type SessionOptions } from './library/ProjectSession'
import { ProjectError } from './project/errors'

/** App-level state: settings plus the one open project. Electron-free so it can be tested. */
export class AppController {
  private settings: AppSettings = { ...DEFAULT_SETTINGS, deviceId: '' }
  private session: ProjectSession | null = null

  constructor(
    private readonly settingsFile: string,
    private readonly emit: (event: ResearchEvent) => void,
    /** `autoSync: null` turns the automatic sync off (tests); otherwise it follows the settings. */
    private readonly sessionDefaults: Omit<SessionOptions, 'contactEmail' | 'openalexApiKey'> = {}
  ) {}

  async init(): Promise<void> {
    this.settings = await loadSettings(this.settingsFile)
    // Idempotent: persists a freshly generated deviceId when the settings file didn't have one yet.
    await saveSettings(this.settingsFile, this.settings)
    const last = this.settings.lastProjectPath
    if (!last) return
    if (!existsSync(join(last, 'project.yaml'))) {
      await this.setSettings({ lastProjectPath: null })
      return
    }
    await this.openProject(last).catch(async (error) => {
      console.error('could not reopen project', last, error)
      await this.setSettings({ lastProjectPath: null })
    })
  }

  getSettings(): AppSettings {
    return this.settings
  }

  async setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const before = this.settings
    this.settings = { ...this.settings, ...patch }
    await saveSettings(this.settingsFile, this.settings)
    this.session?.http.setContactEmail(this.settings.contactEmail)
    this.session?.http.setOpenAlexApiKey(this.settings.openalexApiKey)
    // A full new interval starts on a reschedule: saving the same values again must not push the next sync back.
    if (before.autoSync !== this.settings.autoSync || before.autoSyncMinutes !== this.settings.autoSyncMinutes) this.session?.rescheduleSync()
    return this.settings
  }

  projectInfo(): ProjectInfo | null {
    if (!this.session) return null
    const cfg = this.session.store.config
    return { root: this.session.store.root, name: cfg.name, contentLanguage: cfg.content_language, pdfPolicy: cfg.pdfs.policy }
  }

  async createProject(root: string, name: string): Promise<ProjectInfo> {
    await this.closeProject()
    this.attach(await ProjectSession.create(root, name, this.sessionOptions()))
    await this.setSettings({ lastProjectPath: root })
    return this.projectInfo()!
  }

  async openProject(root: string): Promise<ProjectInfo> {
    await this.closeProject()
    this.attach(await ProjectSession.open(root, this.sessionOptions()))
    await this.setSettings({ lastProjectPath: root })
    return this.projectInfo()!
  }

  async closeProject(): Promise<void> {
    if (!this.session) return
    const session = this.session
    this.session = null
    await session.close()
    this.emit('project-changed')
  }

  async updateProject(patch: { name?: string; contentLanguage?: string; pdfPolicy?: PdfPolicy }): Promise<ProjectInfo> {
    const session = this.requireSession()
    await session.store.updateConfig({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.contentLanguage !== undefined ? { content_language: patch.contentLanguage } : {}),
      ...(patch.pdfPolicy !== undefined ? { pdfs: { policy: patch.pdfPolicy } } : {})
    })
    this.emit('project-changed')
    return this.projectInfo()!
  }

  requireSession(): ProjectSession {
    if (!this.session) throw new ProjectError('No project is open')
    return this.session
  }

  /** Lets an IPC handler signal that something outside the session's own events changed (e.g. Claude settings, thesis context). */
  notifyProjectChanged(): void {
    this.emit('project-changed')
  }

  /** Whether closing should offer to sync first. A git failure counts as nothing to sync: closing must never get stuck. */
  async hasUnsyncedChanges(): Promise<boolean> {
    return this.session ? this.session.sync.hasUnsynced().catch(() => false) : false
  }

  /** The local similarity model, as Settings → App shows it. */
  async modelInfo(): Promise<ModelInfo> {
    const runtime = this.sessionDefaults.embeddings
    if (!runtime) return { modelId: '', available: false, state: 'missing', sizeBytes: 0, downloading: false }
    const disk = await runtime.status()
    return { modelId: runtime.modelId, available: true, ...disk, downloading: this.session?.cache.hasActiveJobOfType('model_download') ?? false }
  }

  async removeModel(): Promise<void> {
    if (this.session) await this.session.similarity.removeModel()
    else await this.sessionDefaults.embeddings?.remove()
  }

  /**
   * Called on quit: running jobs go back to the queue and resume on the next launch; a sync's fetch or push is cut
   * short (its git would otherwise outlive the app) and no automatic sync starts again.
   */
  async shutdown(): Promise<void> {
    const session = this.session
    this.session = null
    await session?.close()
    await this.sessionDefaults.embeddings?.dispose()
  }

  private sessionOptions(): SessionOptions {
    return {
      ...this.sessionDefaults,
      contactEmail: this.settings.contactEmail,
      openalexApiKey: this.settings.openalexApiKey,
      deviceId: this.settings.deviceId,
      // Read at every tick, so a settings change applies without reopening the project.
      autoSync:
        this.sessionDefaults.autoSync === null
          ? null
          : { enabled: () => this.settings.autoSync, intervalMs: () => this.settings.autoSyncMinutes * 60_000 }
    }
  }

  private attach(session: ProjectSession): void {
    this.session = session
    session.on('library', () => this.emit('library-changed'))
    session.on('jobs', () => this.emit('jobs-changed'))
    session.on('project', () => this.emit('project-changed'))
    session.on('sync', () => this.emit('sync-changed'))
    session.on('facets', () => this.emit('facets-changed'))
    this.emit('project-changed')
    // The first automatic sync may already be running (it starts as the session opens, before these listeners).
    this.emit('sync-changed')
  }
}
