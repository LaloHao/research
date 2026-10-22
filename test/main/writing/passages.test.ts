import { describe, expect, it } from 'vitest'
import { bm25, PassageFinder, queryTerms, windowsOf, WINDOW_CHARS } from '../../../src/main/writing/passages'
import { FakeEmbedder } from '../../helpers/embeddings'

const filler = (word: string, n: number): string => Array.from({ length: n }, () => word).join(' ')

describe('passages', () => {
  it('keeps a claim’s content words, folded and stemmed, without function words, numbers or LaTeX commands', () => {
    expect(queryTerms('La detección de anomalías \\emph{supera} a los métodos 2020 en los registros')).toEqual(['deteccion'.slice(0, 6), 'anomal', 'supera', 'metodo', 'regist'])
  })

  it('cuts pages into windows at whitespace, never across pages', () => {
    const windows = windowsOf([
      { page: 1, text: filler('alpha', 300) },
      { page: 2, text: 'short page' }
    ])
    expect(windows.every((w) => w.text.length <= WINDOW_CHARS)).toBe(true)
    expect(windows.filter((w) => w.page === 1).map((w) => w.text).join(' ')).toBe(filler('alpha', 300))
    expect(windows.at(-1)).toEqual({ page: 2, text: 'short page' })
  })

  it('scores the windows that share the claim’s rarer words higher', () => {
    const windows = [
      { page: 1, text: 'log parsing log parsing log parsing' },
      { page: 2, text: 'anomaly detection with log data' },
      { page: 3, text: 'nothing relevant' }
    ]
    const scores = bm25(windows, queryTerms('anomaly detection in logs'))
    expect(scores[1]).toBeGreaterThan(scores[0])
    expect(scores[2]).toBe(0)
  })

  it('finds the best windows in the paper’s order, the first window filling in when few match, references left out', async () => {
    const chunks = [
      { page: 1, text: 'Abstract. We study systems.' },
      { page: 2, text: 'Anomaly detection reaches high recall on HDFS.' },
      { page: 3, text: 'Parsing is fast.' },
      { page: 4, text: 'References [1] Anomaly detection survey.' }
    ]
    const finder = new PassageFinder({ chunks: () => chunks, embedder: async () => null })
    expect(await finder.find('p', 'anomaly detection recall', 2)).toEqual([
      { page: 1, text: 'Abstract. We study systems.' },
      { page: 2, text: 'Anomaly detection reaches high recall on HDFS.' }
    ])
  })

  it('embeds each paper once per check and falls back to words when the model fails', async () => {
    const embedder = new FakeEmbedder()
    let reads = 0
    const finder = new PassageFinder({
      chunks: () => {
        reads++
        return [{ page: 1, text: 'Loghub datasets.' }]
      },
      embedder: async () => embedder
    })
    await finder.find('p', 'datasets', 1)
    await finder.find('p', 'more datasets', 1)
    expect(reads).toBe(1)
    expect(embedder.calls.filter((c) => c.kind === 'passage')).toHaveLength(1)
    const broken = new PassageFinder({
      chunks: () => [{ page: 1, text: 'Loghub datasets.' }],
      embedder: async () => ({ modelId: 'x', dims: 1, embed: async () => Promise.reject(new Error('boom')) })
    })
    expect(await broken.find('p', 'datasets', 1)).toEqual([{ page: 1, text: 'Loghub datasets.' }])
  })
})
