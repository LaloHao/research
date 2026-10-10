import type { FeatureExtractionPipeline } from '@huggingface/transformers'
import { E5_DIMS, E5_MODEL_ID, EmbeddingError, prefixed, type EmbedKind, type Embedder } from './Embedder'
import { progressTracker } from './progress'

/**
 * multilingual-e5-small through transformers.js (onnxruntime-node). Runs in the embeddings utility process, or in
 * process for the evaluation. The package is imported lazily so that loading this module never loads the runtime.
 */
export class TransformersEmbedder implements Embedder {
  readonly modelId = E5_MODEL_ID
  readonly dims = E5_DIMS
  private pipe: Promise<FeatureExtractionPipeline> | null = null

  constructor(private readonly opts: { modelsDir: string; allowDownload: boolean; onProgress?: (fraction: number) => void }) {}

  /** Loads the model; with `allowDownload` it first downloads whatever is missing into `modelsDir`. */
  load(): Promise<FeatureExtractionPipeline> {
    this.pipe ??= (async () => {
      const { env, pipeline } = await import('@huggingface/transformers')
      env.cacheDir = this.opts.modelsDir
      env.localModelPath = this.opts.modelsDir
      env.allowLocalModels = true
      env.allowRemoteModels = this.opts.allowDownload
      const extractor = await pipeline('feature-extraction', E5_MODEL_ID, {
        dtype: 'fp32',
        progress_callback: progressTracker(this.opts.onProgress ?? (() => undefined))
      })
      return extractor as FeatureExtractionPipeline
    })().catch((error: unknown) => {
      this.pipe = null
      throw new EmbeddingError('Could not load the embedding model', { cause: error })
    })
    return this.pipe
  }

  async embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const extractor = await this.load()
    signal?.throwIfAborted()
    // The tokenizer truncates to the model's 512 tokens.
    const output = await extractor(prefixed(texts, kind), { pooling: 'mean', normalize: true })
    const data = output.data as Float32Array
    return texts.map((_, i) => data.slice(i * this.dims, (i + 1) * this.dims))
  }

  async dispose(): Promise<void> {
    const pending = this.pipe
    this.pipe = null
    const extractor = pending ? await pending.catch(() => null) : null
    await extractor?.dispose()
  }
}
