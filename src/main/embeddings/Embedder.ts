export type EmbedKind = 'passage' | 'query'

/** Text → vector. The implementation adds the model's prefix ("passage: " / "query: "). */
export interface Embedder {
  readonly modelId: string
  readonly dims: number
  /** One L2-normalized vector per text, in order. */
  embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]>
}

/** fp32, ~470 MB; stored under <userData>/models, never in a project. */
export const E5_MODEL_ID = 'Xenova/multilingual-e5-small'
export const E5_DIMS = 384

export class EmbeddingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EmbeddingError'
  }
}

export function prefixed(texts: string[], kind: EmbedKind): string[] {
  return texts.map((t) => `${kind}: ${t}`)
}
