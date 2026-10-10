import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { modelDir, modelOnDisk, removeModelFiles } from '../../../src/main/embeddings/modelFiles'
import { tmpDir } from '../../helpers/tmp'

describe('model files', () => {
  it('reports missing until every required file is there, with the folder size', async () => {
    const dir = await tmpDir()
    expect(await modelOnDisk(dir)).toEqual({ state: 'missing', sizeBytes: 0 })
    const model = modelDir(dir)
    expect(model).toBe(join(dir, 'Xenova', 'multilingual-e5-small'))
    await mkdir(join(model, 'onnx'), { recursive: true })
    await writeFile(join(model, 'config.json'), '{}')
    await writeFile(join(model, 'tokenizer.json'), '{"x":1}')
    await writeFile(join(model, 'onnx', 'model.onnx'), 'abcd')
    expect((await modelOnDisk(dir)).state).toBe('missing')
    await writeFile(join(model, 'tokenizer_config.json'), '{}')
    expect(await modelOnDisk(dir)).toEqual({ state: 'ready', sizeBytes: 15 })
    await removeModelFiles(dir)
    expect(existsSync(model)).toBe(false)
  })
})
