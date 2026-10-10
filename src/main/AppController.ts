import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectInfo, ResearchEvent } from '../shared/ipc'
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
    this.settings = { ...this.settings, ...patch }
    await saveSettings(this.settingsFile, this.settings)
    this.session?.http.setContactEmail(this.settings.contactEmail)
    this.session?.http.setOpenAlexApiKey(this.settings.openalexApiKey)
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

  /** Called on quit: running jobs go back to the queue and resume on the next launch. */
  async shutdown(): Promise<void> {
    if (!this.session) return
    const session = this.session
    this.session = null
    await session.close()
  }

  private sessionOptions(): SessionOptions {
    return { ...this.sessionDefaults, contactEmail: this.settings.contactEmail, openalexApiKey: this.settings.openalexApiKey, deviceId: this.settings.deviceId }
  }

  private attach(session: ProjectSession): void {
    this.session = session
    session.on('library', () => this.emit('library-changed'))
    session.on('jobs', () => this.emit('jobs-changed'))
    session.on('project', () => this.emit('project-changed'))
    this.emit('project-changed')
  }
}
