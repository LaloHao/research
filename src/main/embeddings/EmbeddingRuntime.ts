import type { Embedder } from './Embedder'
import { E5_MODEL_ID } from './Embedder'
import { modelOnDisk, removeModelFiles, type ModelOnDisk } from './modelFiles'
import { TransformersEmbedder } from './TransformersEmbedder'

/** Where the local model lives and how to use it: the app uses a utility process, the evaluation runs in process. */
export interface EmbeddingRuntime {
  readonly modelId: string
  /** What is on disk; never downloads. */
  status(): Promise<ModelOnDisk>
  /** Downloads whatever is missing, reporting 0..1. */
  download(onProgress: (fraction: number) => void, signal: AbortSignal): Promise<void>
  /** null while the model is not on disk. */
  embedder(): Promise<Embedder | null>
  /** Stops using the model and deletes its files. */
  remove(): Promise<void>
  dispose(): Promise<void>
}

export class InProcessEmbeddingRuntime implements EmbeddingRuntime {
  readonly modelId = E5_MODEL_ID
  private loaded: TransformersEmbedder | null = null

  constructor(private readonly modelsDir: string) {}

  status(): Promise<ModelOnDisk> {
    return modelOnDisk(this.modelsDir)
  }

  async download(onProgress: (fraction: number) => void, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const embedder = new TransformersEmbedder({ modelsDir: this.modelsDir, allowDownload: true, onProgress })
    await embedder.load()
    await this.dispose()
    this.loaded = embedder
    signal.throwIfAborted()
  }

  async embedder(): Promise<Embedder | null> {
    if (this.loaded) return this.loaded
    if ((await this.status()).state !== 'ready') return null
    this.loaded = new TransformersEmbedder({ modelsDir: this.modelsDir, allowDownload: false })
    return this.loaded
  }

  async remove(): Promise<void> {
    await this.dispose()
    await removeModelFiles(this.modelsDir)
  }

  async dispose(): Promise<void> {
    const loaded = this.loaded
    this.loaded = null
    await loaded?.dispose()
  }
}
