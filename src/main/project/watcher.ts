import { watch } from 'node:fs'
import { sep } from 'node:path'

export interface WatchHandlers {
  onPaper(id: string): void
  onConfig(): void
}

const IGNORED = /^(\.cache|\.git|exports|node_modules)(\/|$)/

/** Debounced notifications for external edits (git pull, Syncthing, an editor). Our own writes come through too; indexing is idempotent. */
export function watchProject(root: string, handlers: WatchHandlers, debounceMs = 300): () => void {
  const timers = new Map<string, NodeJS.Timeout>()
  const schedule = (key: string, fn: () => void): void => {
    clearTimeout(timers.get(key))
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        fn()
      }, debounceMs)
    )
  }
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return
    const rel = filename.toString().split(sep).join('/')
    if (IGNORED.test(rel)) return
    if (rel === 'project.yaml') return schedule('project.yaml', () => handlers.onConfig())
    const m = rel.match(/^papers\/([^/]+)(?:\/([^/]+))?$/)
    if (!m || m[1].startsWith('.') || m[2]?.startsWith('.')) return
    const id = m[1]
    schedule(`paper:${id}`, () => handlers.onPaper(id))
  })
  watcher.on('error', (error) => console.error('project watcher', error))
  return () => {
    watcher.close()
    for (const timer of timers.values()) clearTimeout(timer)
  }
}
