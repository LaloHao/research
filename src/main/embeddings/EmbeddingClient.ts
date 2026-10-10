import { EmbeddingError, type EmbedKind } from './Embedder'
import type { WorkerCall, WorkerRequest, WorkerResponse } from './protocol'

interface Pending {
  resolve: (res: WorkerResponse) => void
  reject: (error: Error) => void
  onProgress?: (fraction: number) => void
}

/** Main-process side of the embeddings worker: matches replies to requests by id. */
export class EmbeddingClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly port: { postMessage(message: WorkerRequest): void }) {}

  /** Feed every message from the worker here. */
  receive(message: WorkerResponse): void {
    const call = this.pending.get(message.id)
    if (!call) return
    if (message.type === 'progress') {
      call.onProgress?.(message.fraction)
      return
    }
    this.pending.delete(message.id)
    if (message.type === 'error') call.reject(new EmbeddingError(message.message))
    else call.resolve(message)
  }

  /** The worker went away: every pending call fails. */
  failAll(reason: string): void {
    const calls = [...this.pending.values()]
    this.pending.clear()
    for (const call of calls) call.reject(new EmbeddingError(reason))
  }

  async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
    const res = await this.call({ type: 'embed', texts, kind })
    if (res.type !== 'vectors') throw new EmbeddingError('Unexpected reply from the embeddings process')
    return res.vectors
  }

  async download(onProgress: (fraction: number) => void): Promise<void> {
    await this.call({ type: 'download' }, onProgress)
  }

  private call(call: WorkerCall, onProgress?: (fraction: number) => void): Promise<WorkerResponse> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress })
      this.port.postMessage({ ...call, id })
    })
  }
}
