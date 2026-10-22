import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { CHATS_DIR } from './chatFile'
import { DRAFTS_DIR } from './draftFile'
import { MAPPING_ID } from '../../shared/mapping'
import { FACET_SUGGESTIONS_FILE } from './facetSuggestionsFile'
import { MAPPINGS_DIR } from './mappingFiles'
import { RELATIONS_FILE } from './relationsFile'
import { TRASH_DIR } from './trashPaths'

export interface WatchHandlers {
  /** `files` are the names changed inside `papers/<id>/` during the debounce window; the folder itself is `PAPER_FOLDER`. */
  onPaper(id: string, files: ReadonlySet<string>): void
  onConfig(): void
  /** relations.yaml at the project root changed. */
  onRelations?(): void
  /** facet-suggestions.yaml at the project root changed. */
  onFacetSuggestions?(): void
  /** `.trash/` appeared or went away, or a folder moved in or out of it (a removal or restore, here or through git). */
  onTrash?(): void
  /** `chats/` appeared or went away, or a conversation file in it was written, replaced or removed. */
  onChats?(): void
  /** `drafts/` appeared or went away, or a draft file in it was written, replaced or removed. */
  onDrafts?(): void
  /** A file in `mappings/<id>/` was written, replaced or removed, or the mapping's folder appeared or went away. */
  onMappings?(id: string): void
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

  /**
   * Watches a folder of one-file records (chats/, drafts/) once it exists: files come and go in it (atomic writes, git
   * checkouts, deletions). A root event for the folder itself (`rearm`) always re-opens the watch: the folder may have
   * been removed and recreated between two events (a git checkout), and the old watch would be left on the deleted
   * folder. Its inode cannot tell: the filesystem may hand the new folder the same one.
   */
  const flatDir = (name: string, onChange: () => void): { sync: (rearm: boolean) => void; close: () => void } => {
    const dir = join(root, name)
    let watcher: FSWatcher | null = null
    const changed = (): void => schedule(name, onChange)
    const close = (): void => {
      watcher?.close()
      watcher = null
    }
    const sync = (rearm: boolean): void => {
      if (closed) return
      if (rearm || !isDir(dir)) close()
      if (isDir(dir))
        watcher ??= watchDir(
          dir,
          (entry) => {
            if (!entry.startsWith('.')) changed()
          },
          close
        )
      if (rearm) changed()
    }
    return { sync, close }
  }
  const chatsDir = flatDir(CHATS_DIR, () => handlers.onChats?.())
  const draftsDir = flatDir(DRAFTS_DIR, () => handlers.onDrafts?.())

  const mappingsDir = join(root, MAPPINGS_DIR)
  let mappingsWatcher: FSWatcher | null = null
  const mappingWatchers = new Map<string, FSWatcher>()
  const mappingChanged = (id: string): void => schedule(`mapping:${id}`, () => handlers.onMappings?.(id))
  const closeMapping = (id: string): void => {
    mappingWatchers.get(id)?.close()
    mappingWatchers.delete(id)
  }
  const closeMappingsDir = (): void => {
    mappingsWatcher?.close()
    mappingsWatcher = null
    for (const id of [...mappingWatchers.keys()]) closeMapping(id)
  }
  /** One folder per mapping: its files are replaced by atomic writes and git checkouts. Names that are not mapping ids are ignored. */
  const syncMapping = (id: string): void => {
    if (closed || !MAPPING_ID.test(id)) return
    if (!isDir(join(mappingsDir, id))) return closeMapping(id)
    if (mappingWatchers.has(id)) return
    const w = watchDir(
      join(mappingsDir, id),
      (name) => {
        if (!name.startsWith('.')) mappingChanged(id)
      },
      () => closeMapping(id)
    )
    if (w) mappingWatchers.set(id, w)
  }
  const mappingFolders = (): string[] => subfolders(mappingsDir).filter((id) => MAPPING_ID.test(id))
  /**
   * Watches mappings/ and each mapping folder in it. A root event for mappings/ itself (`rearm`) re-opens everything and
   * reports every mapping, like chats/: the folder may have been removed and recreated between two events.
   */
  const syncMappingsDir = (rearm: boolean): void => {
    if (closed) return
    if (rearm || !isDir(mappingsDir)) closeMappingsDir()
    if (isDir(mappingsDir)) {
      mappingsWatcher ??= watchDir(
        mappingsDir,
        (name) => {
          if (!MAPPING_ID.test(name)) return
          syncMapping(name)
          mappingChanged(name)
        },
        closeMappingsDir
      )
      for (const id of mappingFolders()) syncMapping(id)
    }
    if (rearm) for (const id of mappingFolders()) mappingChanged(id)
  }

  const rootWatcher = watchDir(
    root,
    (name) => {
      if (name === PROJECT_FILE) schedule(PROJECT_FILE, () => handlers.onConfig())
      else if (name === RELATIONS_FILE) schedule(RELATIONS_FILE, () => handlers.onRelations?.())
      else if (name === FACET_SUGGESTIONS_FILE) schedule(FACET_SUGGESTIONS_FILE, () => handlers.onFacetSuggestions?.())
      else if (name === CHATS_DIR) chatsDir.sync(true)
      else if (name === DRAFTS_DIR) draftsDir.sync(true)
      else if (name === MAPPINGS_DIR) syncMappingsDir(true)
      else if (name === TRASH_DIR) syncTrashDir(true)
      else if (name === 'papers') syncPapersDir()
    },
    () => undefined
  )
  syncPapersDir()
  syncTrashDir(false)
  chatsDir.sync(false)
  draftsDir.sync(false)
  syncMappingsDir(false)

  return () => {
    closed = true
    rootWatcher?.close()
    closePapersDir()
    closeTrashDir()
    chatsDir.close()
    draftsDir.close()
    closeMappingsDir()
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
