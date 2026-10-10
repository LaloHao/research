/**
 * Turns transformers.js download events (one stream per file: initiate, download, progress, done) into a single
 * 0..1 fraction over the bytes of every file seen so far. The model file dominates, so the fraction barely moves back
 * when a new small file starts. Check the event shape (ProgressInfo) when upgrading @huggingface/transformers.
 */
export function progressTracker(onProgress: (fraction: number) => void): (event: unknown) => void {
  const files = new Map<string, { loaded: number; total: number }>()
  return (event) => {
    if (!event || typeof event !== 'object') return
    const e = event as { status?: string; file?: string; loaded?: number; total?: number }
    if (!e.file) return
    if (e.status === 'progress' && typeof e.loaded === 'number' && typeof e.total === 'number' && e.total > 0) {
      files.set(e.file, { loaded: e.loaded, total: e.total })
    } else if (e.status === 'done') {
      const file = files.get(e.file)
      if (!file) return
      file.loaded = file.total
    } else {
      return
    }
    let loaded = 0
    let total = 0
    for (const f of files.values()) {
      loaded += f.loaded
      total += f.total
    }
    if (total > 0) onProgress(loaded / total)
  }
}
