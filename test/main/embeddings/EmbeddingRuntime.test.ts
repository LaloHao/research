import { describe, expect, it } from 'vitest'
import { prefixed } from '../../../src/main/embeddings/Embedder'
import { InProcessEmbeddingRuntime } from '../../../src/main/embeddings/EmbeddingRuntime'
import { FakeEmbeddingRuntime, fakeVector } from '../../helpers/embeddings'
import { tmpDir } from '../../helpers/tmp'

/** Fake vectors are normalized: their dot product is the cosine. */
const dot = (a: Float32Array, b: Float32Array): number => a.reduce((sum, x, i) => sum + x * b[i], 0)

describe('embedding runtimes', () => {
  it('adds the e5 prefix', () => {
    expect(prefixed(['a', 'b'], 'passage')).toEqual(['passage: a', 'passage: b'])
    expect(prefixed(['q'], 'query')).toEqual(['query: q'])
  })

  it('has no in-process embedder until the model is on disk (and never downloads to find out)', async () => {
    const runtime = new InProcessEmbeddingRuntime(await tmpDir())
    expect(await runtime.status()).toEqual({ state: 'missing', sizeBytes: 0 })
    expect(await runtime.embedder()).toBeNull()
  })

  it('gives tests a deterministic fake whose vectors reflect shared words', async () => {
    expect(dot(fakeVector('log anonymization with ner'), fakeVector('ner with log anonymization'))).toBeCloseTo(1)
    expect(dot(fakeVector('log anonymization'), fakeVector('protein folding'))).toBeLessThan(0.5)
    const runtime = new FakeEmbeddingRuntime(false)
    expect(await runtime.embedder()).toBeNull()
    const seen: number[] = []
    await runtime.download((f) => seen.push(f), new AbortController().signal)
    expect(seen).toEqual([0.5, 1])
    const [v] = await (await runtime.embedder())!.embed(['x'], 'passage')
    expect(v).toHaveLength(16)
  })
})
