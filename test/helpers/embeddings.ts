import type { EmbedKind, Embedder } from '../../src/main/embeddings/Embedder'
import type { EmbeddingRuntime } from '../../src/main/embeddings/EmbeddingRuntime'
import type { ModelOnDisk } from '../../src/main/embeddings/modelFiles'

/** Bag of words hashed into `dims` buckets, L2-normalized: texts sharing words get a high cosine. */
export function fakeVector(text: string, dims = 16): Float32Array {
  const v = new Float32Array(dims)
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let h = 2166136261
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619)
    v[(h >>> 0) % dims] += 1
  }
  const norm = Math.hypot(...v)
  return norm ? v.map((x) => x / norm) : v
}

export class FakeEmbedder implements Embedder {
  readonly modelId = 'fake-embedder'
  readonly dims = 16
  readonly calls: { texts: string[]; kind: EmbedKind }[] = []

  async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
    this.calls.push({ texts, kind })
    return texts.map((t) => fakeVector(t, this.dims))
  }
}

export class FakeEmbeddingRuntime implements EmbeddingRuntime {
  readonly modelId = 'fake-embedder'
  readonly embedderInstance = new FakeEmbedder()
  downloads = 0
  removed = 0

  constructor(public ready = true) {}

  async status(): Promise<ModelOnDisk> {
    return { state: this.ready ? 'ready' : 'missing', sizeBytes: this.ready ? 1000 : 0 }
  }

  async download(onProgress: (fraction: number) => void, _signal?: AbortSignal): Promise<void> {
    this.downloads++
    onProgress(0.5)
    onProgress(1)
    this.ready = true
  }

  async embedder(): Promise<Embedder | null> {
    return this.ready ? this.embedderInstance : null
  }

  async remove(): Promise<void> {
    this.removed++
    this.ready = false
  }

  async dispose(): Promise<void> {}
}
