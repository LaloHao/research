import { watch } from 'node:fs'
import { sep } from 'node:path'

export interface WatchHandlers {
  /** `files` are the names changed inside `papers/<id>/` during the debounce window; the folder itself is `PAPER_FOLDER`. */
  onPaper(id: string, files: ReadonlySet<string>): void
  onConfig(): void
}

export const PAPER_FOLDER = '.'

const IGNORED = /^(\.cache|\.git|exports|node_modules)(\/|$)/

/** Debounced notifications for external edits (git pull, a file-sync tool, an editor). Our own writes come through too; indexing is idempotent. */
export function watchProject(root: string, handlers: WatchHandlers, debounceMs = 300): () => void {
  const timers = new Map<string, NodeJS.Timeout>()
  const changed = new Map<string, Set<string>>()
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
    const files = changed.get(id) ?? new Set<string>()
    files.add(m[2] ?? PAPER_FOLDER)
    changed.set(id, files)
    schedule(`paper:${id}`, () => {
      changed.delete(id)
      handlers.onPaper(id, files)
    })
  })
  watcher.on('error', (error) => console.error('project watcher', error))
  return () => {
    watcher.close()
    for (const timer of timers.values()) clearTimeout(timer)
  }
}
