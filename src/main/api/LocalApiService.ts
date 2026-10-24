import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ApiStartError, LocalApiStatus } from '../../shared/localApi'
import { appLog } from '../log/appLog'
import { startLocalApiServer, type LocalApiServerHandle, type LocalApiServerOptions } from './LocalApiServer'
import type { ApiContext, ApiTool } from './registry'

export const API_FILE = 'api.json'

/** What an editor reads to connect: the endpoint and the bearer token. */
export interface ApiConnection {
  url: string
  token: string
}

export const newToken = (): string => randomBytes(32).toString('base64url')

/** `<dir>/api.json`, readable by this user only (0600), written whole through a temp file. */
export async function writeApiFile(file: string, connection: ApiConnection): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

export async function readApiFile(file: string): Promise<Partial<ApiConnection>> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null) return {}
    const { url, token } = raw as Record<string, unknown>
    return { ...(typeof url === 'string' ? { url } : {}), ...(typeof token === 'string' && token.length >= 32 ? { token } : {}) }
  } catch {
    return {}
  }
}

export interface LocalApiDeps {
  /** The app's data folder (`<userData>`): api.json goes there. */
  dir: string
  context: () => ApiContext | null
  allowCostly: () => boolean
  /** The token, as soon as it is known or changes: the app log redacts it. */
  onToken: (token: string) => void
  tools?: ApiTool[]
  /** Injectable for tests. */
  start?: (opts: LocalApiServerOptions) => Promise<LocalApiServerHandle>
}

/**
 * The local API's lifecycle: off by default; on, it listens on 127.0.0.1 at the configured port whether or not a
 * project is open (with none, tools answer `no_project`, so the editor can say so). The token is generated the first
 * time it is turned on and kept in api.json with the URL; «Regenerar token» replaces it at once.
 */
export class LocalApiService {
  private server: LocalApiServerHandle | null = null
  private token: string | null = null
  private settings = { enabled: false, port: 0, allowCostly: false }
  private error: ApiStartError | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: LocalApiDeps) {}

  get file(): string {
    return join(this.deps.dir, API_FILE)
  }

  status(): LocalApiStatus {
    return {
      enabled: this.settings.enabled,
      running: this.server !== null,
      port: this.server?.port ?? this.settings.port,
      url: this.server?.url ?? null,
      allowCostly: this.settings.allowCostly,
      file: this.file,
      error: this.error
    }
  }

  /** The current token, for «Copiar token»; null until the API was first turned on. */
  currentToken(): string | null {
    return this.token
  }

  /** Starts, stops or moves the server to follow the settings; one change at a time. */
  apply(settings: { enabled: boolean; port: number; allowCostly: boolean }): Promise<void> {
    return this.serial(async () => {
      const before = this.settings
      this.settings = { ...settings }
      const running = this.server !== null
      if (!settings.enabled) return this.stop()
      if (running && before.port === settings.port) return
      await this.stop()
      await this.start()
    })
  }

  async regenerateToken(): Promise<void> {
    return this.serial(async () => {
      this.setToken(newToken())
      await this.writeFile()
      appLog.info('api_token_regenerated')
    })
  }

  close(): Promise<void> {
    return this.serial(() => this.stop())
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  private setToken(token: string): void {
    this.token = token
    this.deps.onToken(token)
  }

  private async ensureToken(): Promise<void> {
    if (this.token) return
    const saved = await readApiFile(this.file)
    this.setToken(saved.token ?? newToken())
  }

  private async writeFile(): Promise<void> {
    if (!this.token) return
    await writeApiFile(this.file, { url: this.server?.url ?? `http://127.0.0.1:${this.settings.port}/mcp`, token: this.token })
  }

  private async start(): Promise<void> {
    this.error = null
    await this.ensureToken()
    const start = this.deps.start ?? startLocalApiServer
    try {
      this.server = await start({
        port: this.settings.port,
        token: () => this.token ?? '',
        context: this.deps.context,
        allowCostly: () => this.settings.allowCostly,
        tools: this.deps.tools,
        onCall: (tool, ok, ms) => appLog.debug('api_call', { tool, ok, ms })
      })
    } catch (error) {
      this.error = (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE' ? 'port_in_use' : 'start_failed'
      appLog.warn('api_start_failed', { port: this.settings.port, code: this.error })
      return
    }
    await this.writeFile()
    appLog.info('api_start', { port: this.server.port })
  }

  private async stop(): Promise<void> {
    this.error = null
    const server = this.server
    if (!server) return
    this.server = null
    await server.close()
    appLog.info('api_stop', { port: server.port })
  }
}
