import { utilityProcess, type UtilityProcess } from 'electron'
import { E5_DIMS, E5_MODEL_ID, type Embedder } from './Embedder'
import { EmbeddingClient } from './EmbeddingClient'
import type { EmbeddingRuntime } from './EmbeddingRuntime'
import { modelOnDisk, removeModelFiles, type ModelOnDisk } from './modelFiles'
import type { WorkerResponse } from './protocol'

/** The app's runtime: transformers.js in an Electron utility process, models under <userData>/models. */
export class UtilityEmbeddingRuntime implements EmbeddingRuntime {
  readonly modelId = E5_MODEL_ID
  private child: UtilityProcess | null = null
  private client: EmbeddingClient | null = null

  constructor(
    private readonly modelsDir: string,
    private readonly workerPath: string
  ) {}

  status(): Promise<ModelOnDisk> {
    return modelOnDisk(this.modelsDir)
  }

  async download(onProgress: (fraction: number) => void, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const client = this.ensure()
    // A download cannot be interrupted inside transformers.js: cancelling kills the process (a partial file is redone next time).
    const abort = (): void => this.kill('Download cancelled')
    signal.addEventListener('abort', abort, { once: true })
    try {
      await client.download(onProgress)
    } finally {
      signal.removeEventListener('abort', abort)
    }
    signal.throwIfAborted()
  }

  async embedder(): Promise<Embedder | null> {
    if ((await this.status()).state !== 'ready') return null
    return { modelId: this.modelId, dims: E5_DIMS, embed: (texts, kind) => this.ensure().embed(texts, kind) }
  }

  async remove(): Promise<void> {
    this.kill('The model was removed')
    await removeModelFiles(this.modelsDir)
  }

  async dispose(): Promise<void> {
    this.kill('Shutting down')
  }

  private ensure(): EmbeddingClient {
    if (this.client) return this.client
    const child = utilityProcess.fork(this.workerPath, [], {
      serviceName: 'research-embeddings',
      env: { ...process.env, RESEARCH_MODELS_DIR: this.modelsDir },
      stdio: 'inherit'
    })
    const client = new EmbeddingClient({ postMessage: (message) => child.postMessage(message) })
    child.on('message', (message: WorkerResponse) => client.receive(message))
    child.on('exit', () => {
      client.failAll('The embeddings process exited')
      if (this.child === child) {
        this.child = null
        this.client = null
      }
    })
    this.child = child
    this.client = client
    return client
  }

  private kill(reason: string): void {
    const child = this.child
    const client = this.client
    this.child = null
    this.client = null
    client?.failAll(reason)
    child?.kill()
  }
}
