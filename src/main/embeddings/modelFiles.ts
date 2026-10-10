import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { E5_MODEL_ID } from './Embedder'

export interface ModelOnDisk {
  state: 'missing' | 'ready'
  sizeBytes: number
}

/** What transformers.js needs to load the fp32 model offline. */
export const REQUIRED_MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'] as const

/** transformers.js keeps each model under <cacheDir>/<org>/<name>/. */
export function modelDir(modelsDir: string, modelId: string = E5_MODEL_ID): string {
  return join(modelsDir, ...modelId.split('/'))
}

export async function modelOnDisk(modelsDir: string, modelId: string = E5_MODEL_ID): Promise<ModelOnDisk> {
  const dir = modelDir(modelsDir, modelId)
  const sizeBytes = await dirSize(dir)
  for (const file of REQUIRED_MODEL_FILES) {
    const info = await stat(join(dir, file)).catch(() => null)
    if (!info || info.size === 0) return { state: 'missing', sizeBytes }
  }
  return { state: 'ready', sizeBytes }
}

export async function removeModelFiles(modelsDir: string, modelId: string = E5_MODEL_ID): Promise<void> {
  await rm(modelDir(modelsDir, modelId), { recursive: true, force: true })
}

async function dirSize(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  let total = 0
  for (const entry of entries) if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size
  return total
}
