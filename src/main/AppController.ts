import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatStreamUpdate } from '../shared/chat'
import type { DraftStreamUpdate } from '../shared/writing/draft'
import type { ProjectInfo, ResearchEvent } from '../shared/ipc'
import type { ExtensionStatus, PairingCode, PairingRequest } from '../shared/extension'
import type { ApiOpenPaper, LocalApiStatus } from '../shared/localApi'
import type { ModelInfo } from '../shared/relations'
import type { PdfPolicy } from '../shared/schemas'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/settings'
import { LocalApiService } from './api/LocalApiService'
import { ExtensionCapture, type CaptureLibrary, type ReaderPrinter } from './api/extension/capture'
import { ExtensionPairing, EXTENSIONS_FILE } from './api/extension/pairing'
import { extensionRoutes } from './api/extension/routes'
import type { ApiContext } from './api/registry'
import { loadSettings, saveSettings } from './appSettings'
import { ProjectSession, type SessionOptions } from './library/ProjectSession'
import { appLog, setLogSecrets } from './log/appLog'
import { libraryTools } from './mcp/libraryTools'
import { ProjectError } from './project/errors'

/** Where the local API keeps api.json, and how it shows a paper or a conversation in the window. */
export interface ApiHost {
  dir: string
  openInApp: (request: ApiOpenPaper) => void
  openChatInApp: (chatId: string) => void
  /** The browser extension: «¿Vincular la extensión…?» in the window (null hides it), and the reader-PDF printer. */
  showPairingRequest?: (request: PairingRequest | null) => void
  printReader?: ReaderPrinter
  /** The app's version, as the extension's «Probar conexión» shows it. */
  version?: string
}

/** App-level state: settings plus the one open project. Electron-free so it can be tested. */
export class AppController {
  private settings: AppSettings = { ...DEFAULT_SETTINGS, deviceId: '' }
  private session: ProjectSession | null = null
  private readonly api: LocalApiService | null
  private apiToken: string | null = null
  /** The browser extension's pairing and paired list; none without the local API. */
  private readonly pairing: ExtensionPairing | null

  constructor(
    private readonly settingsFile: string,
    private readonly emit: (event: ResearchEvent) => void,
    /** `autoSync: null` turns the automatic sync off (tests); otherwise it follows the settings. */
    private readonly sessionDefaults: Omit<SessionOptions, 'contactEmail' | 'openalexApiKey'> = {},
    /** Chat answers as they stream, for the window. */
    private readonly emitChatStream: (update: ChatStreamUpdate) => void = () => undefined,
    /** Drafts as they stream, for the window. */
    private readonly emitDraftStream: (update: DraftStreamUpdate) => void = () => undefined,
    /** The local API (Settings → Aplicación → «API local»); none in tests that don't need it. */
    apiHost: ApiHost | null = null
  ) {
    this.pairing = apiHost
      ? new ExtensionPairing({
          file: join(apiHost.dir, EXTENSIONS_FILE),
          ask: (request) => apiHost.showPairingRequest?.(request),
          settled: () => apiHost.showPairingRequest?.(null),
          changed: () => this.emit('extensions-changed')
        })
      : null
    const pairing = this.pairing
    this.api = apiHost
      ? new LocalApiService({
          dir: apiHost.dir,
          context: () => this.apiContext(apiHost),
          allowCostly: () => this.settings.apiAllowCostly,
          onToken: (token) => {
            this.apiToken = token
            this.registerSecrets()
          },
          extension: pairing
            ? extensionRoutes({
                pairing,
                capture: new ExtensionCapture({
                  library: () => this.captureLibrary(apiHost),
                  printReader: apiHost.printReader ?? (async () => null)
                }),
                projectName: () => this.session?.store.config.name ?? null,
                version: apiHost.version ?? '',
                onCall: (endpoint, status, ms) => appLog.debug('extension_call', { endpoint, status, ms })
              })
            : undefined
        })
      : null
  }

  async init(): Promise<void> {
    this.settings = await loadSettings(this.settingsFile)
    this.registerSecrets()
    // Idempotent: persists a freshly generated deviceId when the settings file didn't have one yet.
    await saveSettings(this.settingsFile, this.settings)
    await this.pairing?.load()
    await this.applyApi()
    const last = this.settings.lastProjectPath
    if (!last) return
    if (!existsSync(join(last, 'project.yaml'))) {
      await this.setSettings({ lastProjectPath: null })
      return
    }
    await this.openProject(last).catch(async (error) => {
      console.error('could not reopen project', last, error)
      appLog.warn('project_reopen_failed', { root: last })
      await this.setSettings({ lastProjectPath: null })
    })
  }

  getSettings(): AppSettings {
    return this.settings
  }

  async setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const before = this.settings
    this.settings = { ...this.settings, ...patch }
    this.registerSecrets()
    await saveSettings(this.settingsFile, this.settings)
    this.session?.http.setContactEmail(this.settings.contactEmail)
    this.session?.http.setOpenAlexApiKey(this.settings.openalexApiKey)
    // A full new interval starts on a reschedule: saving the same values again must not push the next sync back.
    if (before.autoSync !== this.settings.autoSync || before.autoSyncMinutes !== this.settings.autoSyncMinutes) this.session?.rescheduleSync()
    await this.applyApi()
    this.emit('settings-changed')
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
    appLog.info('project_create', { root })
    await this.setSettings({ lastProjectPath: root })
    return this.projectInfo()!
  }

  async openProject(root: string): Promise<ProjectInfo> {
    await this.closeProject()
    try {
      this.attach(await ProjectSession.open(root, this.sessionOptions()))
    } catch (error) {
      appLog.warn('project_open_failed', { root, error })
      throw error
    }
    appLog.info('project_open', { root })
    await this.setSettings({ lastProjectPath: root })
    return this.projectInfo()!
  }

  async closeProject(): Promise<void> {
    if (!this.session) return
    const session = this.session
    this.session = null
    appLog.info('project_close', { root: session.store.root })
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
   * short (its git would otherwise outlive the app) and no automatic sync starts again; Claude runs (the window's and
   * the local API's) stop.
   */
  async shutdown(): Promise<void> {
    const session = this.session
    this.session = null
    appLog.info('app_shutdown', { project: session?.store.root ?? null })
    // The API stops listening at once and waits (bounded) for the calls in progress; the session's close stops the
    // Claude runs they wait on (the API's included), so they answer and the wait ends.
    const api = this.api?.close()
    await session?.close()
    await api
    await this.sessionDefaults.embeddings?.dispose()
  }

  /** «API local» in Settings; off (and never started) when the app runs without one. */
  apiStatus(): LocalApiStatus | null {
    return this.api?.status() ?? null
  }

  /** The token for «Copiar token»; null until the API was first turned on. */
  apiCurrentToken(): string | null {
    return this.api?.currentToken() ?? null
  }

  /** «Regenerar token»: the old one stops working at once and api.json gets the new one. */
  async regenerateApiToken(): Promise<LocalApiStatus | null> {
    await this.api?.regenerateToken()
    return this.apiStatus()
  }

  /** Settings → Aplicación → «Extensión del navegador». */
  extensionStatus(): ExtensionStatus | null {
    if (!this.pairing) return null
    return { apiRunning: this.api?.status().running ?? false, code: this.pairing.currentCode(), paired: this.pairing.list() }
  }

  /** «Vincular extensión»: a new code; refused while the local API is not listening (the extension could not reach it). */
  startExtensionPairing(): PairingCode {
    if (!this.pairing || !this.api?.status().running) throw new Error('The local API is not running')
    appLog.info('extension_pairing_started')
    return this.pairing.start()
  }

  cancelExtensionPairing(): void {
    this.pairing?.cancel()
  }

  answerExtensionPairing(id: string, accepted: boolean): void {
    appLog.info('extension_pairing_answered', { accepted })
    this.pairing?.answer(id, accepted)
  }

  pendingExtensionPairing(): PairingRequest | null {
    return this.pairing?.pendingRequest() ?? null
  }

  async revokeExtension(id: string): Promise<void> {
    await this.pairing?.revoke(id)
    appLog.info('extension_revoked')
  }

  /** What the extension's capture endpoints do with the open project. */
  private captureLibrary(host: ApiHost): CaptureLibrary | null {
    const session = this.session
    if (!session) return null
    return {
      dedupeEntries: () => session.cache.dedupeEntries(),
      title: (key) => session.cache.getPaper(key)?.title ?? null,
      findByUrl: (url) => session.findCapturedPage(url),
      enqueueIdentifier: (input) => session.queue.enqueue({ type: 'ingest_identifier', input }),
      whenDone: (job, ms) => session.queue.whenDone(job, ms),
      ingestCapture: (capture) => session.ingestCapture(capture),
      ingestPdf: (bytes, name, url) => session.ingestPdfData(bytes, name, url),
      replacePdf: (key, pdf) => session.replaceCapturedPdf(key, pdf),
      open: (key) => host.openInApp({ paper: key, page: null, quote: null })
    }
  }

  private async applyApi(): Promise<void> {
    await this.api?.apply({ enabled: this.settings.apiEnabled, port: this.settings.apiPort, allowCostly: this.settings.apiAllowCostly })
  }

  /** What the API's tools read: the open project, at the moment of each request. */
  private apiContext(host: ApiHost): ApiContext | null {
    const session = this.session
    if (!session) return null
    return {
      store: session.store,
      cache: session.cache,
      library: libraryTools({ store: session.store, cache: session.cache, map: session.map, embeddings: this.sessionDefaults.embeddings ?? null }),
      writing: session.writing,
      drafts: session.drafts,
      capped: session.capped,
      chats: session.chats,
      openInApp: host.openInApp,
      openChatInApp: host.openChatInApp
    }
  }

  /** The app log replaces the secrets the settings hold wherever they appear, whatever their shape. */
  private registerSecrets(): void {
    setLogSecrets([this.settings.openalexApiKey, this.settings.contactEmail, this.apiToken])
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
    session.on('chats', () => this.emit('chats-changed'))
    session.on('mappings', () => this.emit('mappings-changed'))
    session.on('drafts', () => this.emit('drafts-changed'))
    session.onChatStream((u) => this.emitChatStream(u))
    session.onDraftStream((u) => this.emitDraftStream(u))
    this.emit('project-changed')
    // The first automatic sync may already be running (it starts as the session opens, before these listeners).
    this.emit('sync-changed')
  }
}
