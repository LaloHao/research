import { handleWorkerRequest, type WorkerRequest, type WorkerResponse } from './protocol'
import { TransformersEmbedder } from './TransformersEmbedder'

/** Utility-process entry: owns the ONNX runtime so a crash or a long inference never blocks the main process. */
const modelsDir = process.env.RESEARCH_MODELS_DIR ?? ''
const port = process.parentPort
let embedder: TransformersEmbedder | null = null

/**
 * transformers.js keeps its settings (`env.allowRemoteModels`, ...) in one process-wide object, so a download and an
 * offline load must never run at the same time: every model load goes through this queue, one after the other.
 */
let loads: Promise<unknown> = Promise.resolve()
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = loads.then(task, task)
  loads = run.catch(() => undefined)
  return run
}

port.on('message', (event) => {
  void handleWorkerRequest(
    event.data as WorkerRequest,
    {
      embed: async (texts, kind) => {
        const current = (embedder ??= new TransformersEmbedder({ modelsDir, allowDownload: false }))
        await oneAtATime(() => current.load())
        return current.embed(texts, kind)
      },
      download: (onProgress) =>
        oneAtATime(async () => {
          const fresh = new TransformersEmbedder({ modelsDir, allowDownload: true, onProgress })
          await fresh.load()
          await embedder?.dispose()
          embedder = fresh
        })
    },
    (res: WorkerResponse) => port.postMessage(res)
  )
})
