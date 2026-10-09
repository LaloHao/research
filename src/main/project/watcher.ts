import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

export interface WatchHandlers {
  /** `files` are the names changed inside `papers/<id>/` during the debounce window; the folder itself is `PAPER_FOLDER`. */
  onPaper(id: string, files: ReadonlySet<string>): void
  onConfig(): void
}

export const PAPER_FOLDER = '.'

const PROJECT_FILE = 'project.yaml'

/**
 * Debounced notifications for external edits (git pull, a file-sync tool, an editor). Our own writes come through too; indexing is idempotent.
 *
 * Non-recursive directory watches (the root, `papers/` and each `papers/<id>/`): Node's recursive watcher on Linux stops
 * reporting a file once it has been replaced by a rename (atomic writes, git checkouts), while a directory watch keeps seeing
 * every change of its entries. Dot-prefixed entries (temp files, hidden folders) are ignored.
 */
export function watchProject(root: string, handlers: WatchHandlers, debounceMs = 300): () => void {
  const timers = new Map<string, NodeJS.Timeout>()
  const changed = new Map<string, Set<string>>()
  const paperWatchers = new Map<string, FSWatcher>()
  const papersDir = join(root, 'papers')
  let papersWatcher: FSWatcher | null = null
  let closed = false

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

  const paperChanged = (id: string, file: string): void => {
    const files = changed.get(id) ?? new Set<string>()
    files.add(file)
    changed.set(id, files)
    schedule(`paper:${id}`, () => {
      changed.delete(id)
      handlers.onPaper(id, files)
    })
  }

  const closePaper = (id: string): void => {
    paperWatchers.get(id)?.close()
    paperWatchers.delete(id)
  }

  /** Starts or stops the watch of one paper folder to match the disk. */
  const syncPaper = (id: string): void => {
    if (closed || id.startsWith('.')) return
    if (!isDir(join(papersDir, id))) return closePaper(id)
    if (paperWatchers.has(id)) return
    const w = watchDir(
      join(papersDir, id),
      (name) => {
        if (!name.startsWith('.')) paperChanged(id, name)
      },
      () => closePaper(id)
    )
    if (w) paperWatchers.set(id, w)
  }

  const closePapersDir = (): void => {
    papersWatcher?.close()
    papersWatcher = null
    for (const id of [...paperWatchers.keys()]) closePaper(id)
  }

  /** Watches `papers/` and every paper folder in it, once `papers/` exists. */
  const syncPapersDir = (): void => {
    if (closed) return
    if (!isDir(papersDir)) return closePapersDir()
    papersWatcher ??= watchDir(
      papersDir,
      (id) => {
        if (id.startsWith('.')) return
        syncPaper(id)
        paperChanged(id, PAPER_FOLDER)
      },
      closePapersDir
    )
    for (const id of subfolders(papersDir)) syncPaper(id)
  }

  const rootWatcher = watchDir(
    root,
    (name) => {
      if (name === PROJECT_FILE) schedule(PROJECT_FILE, () => handlers.onConfig())
      else if (name === 'papers') syncPapersDir()
    },
    () => undefined
  )
  syncPapersDir()

  return () => {
    closed = true
    rootWatcher?.close()
    closePapersDir()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }
}

/** A non-recursive watch of `dir`; `onGone` runs when the watch fails (e.g. the folder was removed). */
function watchDir(dir: string, onEntry: (name: string) => void, onGone: () => void): FSWatcher | null {
  try {
    const w = watch(dir, (_event, filename) => {
      if (filename) onEntry(filename.toString())
    })
    w.on('error', (error) => {
      console.error('project watcher', dir, error)
      onGone()
    })
    return w
  } catch {
    return null
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function subfolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return []
  }
}
