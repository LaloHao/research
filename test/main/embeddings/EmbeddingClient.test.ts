import { describe, expect, it } from 'vitest'
import { EmbeddingClient } from '../../../src/main/embeddings/EmbeddingClient'
import { EmbeddingError } from '../../../src/main/embeddings/Embedder'
import { handleWorkerRequest, type WorkerDeps, type WorkerRequest } from '../../../src/main/embeddings/protocol'
import { FakeEmbedder } from '../../helpers/embeddings'

/** A client wired straight to the worker's handler, as the utility process would be, without a process. */
function connected(deps: WorkerDeps): EmbeddingClient {
  const client: EmbeddingClient = new EmbeddingClient({
    postMessage: (req: WorkerRequest) => void handleWorkerRequest(req, deps, (res) => queueMicrotask(() => client.receive(res)))
  })
  return client
}

describe('embeddings worker protocol', () => {
  it('embeds texts through the worker', async () => {
    const fake = new FakeEmbedder()
    const client = connected({ embed: (texts, kind) => fake.embed(texts, kind), download: async () => {} })
    expect(await client.embed(['a b', 'c'], 'passage')).toHaveLength(2)
    expect(fake.calls).toEqual([{ texts: ['a b', 'c'], kind: 'passage' }])
  })

  it('relays download progress, then completion', async () => {
    const seen: number[] = []
    const client = connected({
      embed: async () => [],
      download: async (onProgress) => {
        onProgress(0.3)
        onProgress(1)
      }
    })
    await client.download((f) => seen.push(f))
    expect(seen).toEqual([0.3, 1])
  })

  it('turns a worker error into an EmbeddingError', async () => {
    const client = connected({
      embed: async () => {
        throw new Error('no model')
      },
      download: async () => {}
    })
    await expect(client.embed(['x'], 'query')).rejects.toBeInstanceOf(EmbeddingError)
  })

  it('fails every pending call when the worker goes away', async () => {
    const client = new EmbeddingClient({ postMessage: () => {} })
    const pending = client.embed(['x'], 'passage')
    client.failAll('The embeddings process exited')
    await expect(pending).rejects.toThrow('The embeddings process exited')
  })
})
