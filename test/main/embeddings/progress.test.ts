import { describe, expect, it } from 'vitest'
import { progressTracker } from '../../../src/main/embeddings/progress'

describe('progressTracker', () => {
  it('aggregates the progress of every file into one fraction and ignores other events', () => {
    const seen: number[] = []
    const track = progressTracker((f) => seen.push(f))
    track({ status: 'initiate', file: 'config.json' })
    track({ status: 'progress', file: 'config.json', loaded: 50, total: 100 })
    track({ status: 'progress', file: 'onnx/model.onnx', loaded: 100, total: 900 })
    track({ status: 'done', file: 'config.json' })
    track('noise')
    track({ status: 'ready', task: 'feature-extraction' })
    expect(seen).toEqual([0.5, 0.15, 0.2])
  })
})
