import type { EmbedKind } from './Embedder'

/** Messages between the main process and the embeddings utility process. */
export type WorkerCall = { type: 'embed'; texts: string[]; kind: EmbedKind } | { type: 'download' }
export type WorkerRequest = WorkerCall & { id: number }
export type WorkerResponse =
  | { id: number; type: 'progress'; fraction: number }
  | { id: number; type: 'vectors'; vectors: Float32Array[] }
  | { id: number; type: 'done' }
  | { id: number; type: 'error'; message: string }

export interface WorkerDeps {
  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>
  download(onProgress: (fraction: number) => void): Promise<void>
}

/** Runs one request inside the worker; every request ends with exactly one vectors/done/error message. */
export async function handleWorkerRequest(req: WorkerRequest, deps: WorkerDeps, send: (res: WorkerResponse) => void): Promise<void> {
  try {
    if (req.type === 'embed') {
      send({ id: req.id, type: 'vectors', vectors: await deps.embed(req.texts, req.kind) })
    } else {
      await deps.download((fraction) => send({ id: req.id, type: 'progress', fraction }))
      send({ id: req.id, type: 'done' })
    }
  } catch (error) {
    send({ id: req.id, type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
