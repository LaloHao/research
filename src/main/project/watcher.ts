import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { RELATIONS_FILE } from './relationsFile'
import { TRASH_DIR } from './trashPaths'

export interface WatchHandlers {
  /** `files` are the names changed inside `papers/<id>/` during the debounce window; the folder itself is `PAPER_FOLDER`. */
  onPaper(id: string, files: ReadonlySet<string>): void
  onConfig(): void
  /** relations.yaml at the project root changed. */
  onRelations?(): void
  /** `.trash/` appeared or went away, or a folder moved in or out of it (a removal or restore, here or through git). */
  onTrash?(): void
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

  const trashDir = join(root, TRASH_DIR)
  let trashWatcher: FSWatcher | null = null
  const trashEntryWatchers = new Map<string, FSWatcher>()
  const trashChanged = (): void => schedule(TRASH_DIR, () => handlers.onTrash?.())

  const closeTrashEntry = (id: string): void => {
    trashEntryWatchers.get(id)?.close()
    trashEntryWatchers.delete(id)
  }

  const closeTrashDir = (): void => {
    trashWatcher?.close()
    trashWatcher = null
    for (const id of [...trashEntryWatchers.keys()]) closeTrashEntry(id)
  }

  /** One level deep: git may write trashed.yaml or paper.yaml into a trashed folder after the folder itself arrived. */
  const syncTrashEntry = (id: string): void => {
    if (closed || id.startsWith('.')) return
    if (!isDir(join(trashDir, id))) return closeTrashEntry(id)
    if (trashEntryWatchers.has(id)) return
    const w = watchDir(
      join(trashDir, id),
      (name) => {
        if (!name.startsWith('.')) trashChanged()
      },
      () => closeTrashEntry(id)
    )
    if (w) trashEntryWatchers.set(id, w)
  }

  /** Watches `.trash/` and the top level of each folder in it. */
  const syncTrashDir = (notify: boolean): void => {
    if (closed) return
    if (!isDir(trashDir)) closeTrashDir()
    else {
      trashWatcher ??= watchDir(
        trashDir,
        (name) => {
          if (name.startsWith('.')) return
          syncTrashEntry(name)
          trashChanged()
        },
        closeTrashDir
      )
      for (const id of subfolders(trashDir)) syncTrashEntry(id)
    }
    if (notify) trashChanged()
  }

  const rootWatcher = watchDir(
    root,
    (name) => {
      if (name === PROJECT_FILE) schedule(PROJECT_FILE, () => handlers.onConfig())
      else if (name === RELATIONS_FILE) schedule(RELATIONS_FILE, () => handlers.onRelations?.())
      else if (name === TRASH_DIR) syncTrashDir(true)
      else if (name === 'papers') syncPapersDir()
    },
    () => undefined
  )
  syncPapersDir()
  syncTrashDir(false)

  return () => {
    closed = true
    rootWatcher?.close()
    closePapersDir()
    closeTrashDir()
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
