import type { ConflictChoice } from '../../shared/sync'
import type { ConflictPaths, NameStatus, TreeEntry } from './gitOutput'
import { mergerFor } from './mergers'
import type { MergeResult, ProjectRepo, TreeEdit } from './ProjectRepo'

/** A decision the merge waits for; kept in memory until the user chooses (the working tree did not change). */
export type PendingConflict =
  | { kind: 'file'; id: string; path: string; base: TreeEntry | null; ours: TreeEntry | null; theirs: TreeEntry | null }
  | { kind: 'paper'; id: string; key: string; trashedBy: 'ours' | 'theirs' }

export type MergePlan = { kind: 'clean'; tree: string } | { kind: 'decisions'; conflicts: PendingConflict[] } | { kind: 'outside'; paths: string[] }

export interface MergeCommits {
  /** This machine's commit (HEAD). */
  ours: string
  /** The remote's commit. */
  theirs: string
  base: string
  /** Decisions already made, by conflict id. */
  choices: ReadonlyMap<string, ConflictChoice>
}

interface TrashedPaper {
  key: string
  trashedBy: 'ours' | 'theirs'
}

export const fileConflictId = (path: string): string => `file:${path}`
export const paperConflictId = (key: string): string => `paper:${key}`

const PAPER_PATH = /^(?:papers|\.trash)\/([a-z][a-z0-9]*)\//
const PAPER_YAML = /^(papers|\.trash)\/([a-z][a-z0-9]*)\/paper\.yaml$/
const LIBRARY_FILE = /^papers\/([a-z][a-z0-9]*)\/(.+)$/

const sideEdit = (path: string, entry: TreeEntry | null): TreeEdit => (entry ? { path, mode: entry.mode, oid: entry.oid } : { path, remove: true })

/** Keys of papers a side moved from the library to the trash (paper.yaml deleted from papers/, added to .trash/). */
export function trashedKeys(changes: NameStatus[], prefix: string): Set<string> {
  const left = new Set<string>()
  const arrived = new Set<string>()
  for (const { status, path } of changes) {
    if (!path.startsWith(prefix)) continue
    const m = PAPER_YAML.exec(path.slice(prefix.length))
    if (m?.[1] === 'papers' && status === 'D') left.add(m[2])
    if (m?.[1] === '.trash' && status === 'A') arrived.add(m[2])
  }
  return new Set([...left].filter((key) => arrived.has(key)))
}

/** Keys of library papers a side changed and still has (its paper.yaml was not deleted). */
export function editedKeys(changes: NameStatus[], prefix: string): Set<string> {
  const touched = new Set<string>()
  const gone = new Set<string>()
  for (const { status, path } of changes) {
    if (!path.startsWith(prefix)) continue
    const m = LIBRARY_FILE.exec(path.slice(prefix.length))
    if (!m) continue
    touched.add(m[1])
    if (m[2] === 'paper.yaml' && status === 'D') gone.add(m[1])
  }
  return new Set([...touched].filter((key) => !gone.has(key)))
}

/** Papers one machine trashed while the other edited them (git may have merged that cleanly, carrying the edit into .trash/). */
async function trashedWhileEdited(repo: ProjectRepo, c: MergeCommits): Promise<TrashedPaper[]> {
  const dirs = [`${repo.prefix}papers/`, `${repo.prefix}.trash/`]
  const ours = await repo.nameStatus(c.base, c.ours, dirs)
  const theirs = await repo.nameStatus(c.base, c.theirs, dirs)
  const found: TrashedPaper[] = []
  const editedHere = editedKeys(ours, repo.prefix)
  const editedThere = editedKeys(theirs, repo.prefix)
  for (const key of trashedKeys(ours, repo.prefix)) if (editedThere.has(key)) found.push({ key, trashedBy: 'ours' })
  for (const key of trashedKeys(theirs, repo.prefix)) if (editedHere.has(key)) found.push({ key, trashedBy: 'theirs' })
  return found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/**
 * The tree edits for a decided paper. Keep: the library folder exactly as the machine that edited it has it, and no
 * trash entry. Accept the removal: what git merged stays (an edit it could carry into .trash/ included); a file it could
 * not merge takes the version of the machine that trashed the paper, except a file only the editing machine added
 * (git places it in .trash/ as a conflict): it stays in the trashed copy, like the edits git carried there.
 */
async function paperEdits(repo: ProjectRepo, merged: MergeResult, paper: TrashedPaper, keep: boolean, c: MergeCommits): Promise<TreeEdit[]> {
  const folders = [`${repo.prefix}papers/${paper.key}/`, `${repo.prefix}.trash/${paper.key}/`]
  if (keep) {
    const editor = paper.trashedBy === 'ours' ? c.theirs : c.ours
    const edits: TreeEdit[] = (await repo.lsTree(merged.tree, folders)).map((e) => ({ path: e.path, remove: true }))
    for (const e of await repo.lsTree(editor, [folders[0]])) edits.push({ path: e.path, mode: e.mode, oid: e.oid })
    return edits
  }
  return merged.conflicts
    .filter((x) => folders.some((folder) => x.path.startsWith(folder)))
    .map((x) => {
      const [trasher, editor] = paper.trashedBy === 'ours' ? [x.ours, x.theirs] : [x.theirs, x.ours]
      return sideEdit(x.path, !x.base && !trasher ? editor : trasher)
    })
}

async function autoMerged(repo: ProjectRepo, x: ConflictPaths): Promise<TreeEdit | null> {
  if (!x.ours || !x.theirs) return null
  const merger = mergerFor(x.path.slice(repo.prefix.length))
  if (!merger) return null
  const text = merger({
    base: x.base ? await repo.readText(x.base.oid) : null,
    ours: await repo.readText(x.ours.oid),
    theirs: await repo.readText(x.theirs.oid)
  })
  return text === null ? null : { path: x.path, mode: x.ours.mode, oid: await repo.writeBlob(text) }
}

/**
 * Turns `git merge-tree` into a finished tree, or the decisions still missing. A conflict outside the project folder
 * stops everything; the files the app knows how to merge are merged; the rest waits for (or applies) the user's choice.
 */
export async function planMerge(repo: ProjectRepo, c: MergeCommits): Promise<MergePlan> {
  const merged = await repo.mergeTree(c.ours, c.theirs)
  const outside = merged.conflicts.filter((x) => !x.path.startsWith(repo.prefix)).map((x) => x.path)
  if (outside.length > 0) return { kind: 'outside', paths: outside }

  const edits = new Map<string, TreeEdit>()
  const pending: PendingConflict[] = []
  const papers = await trashedWhileEdited(repo, c)
  for (const paper of papers) {
    const id = paperConflictId(paper.key)
    const choice = c.choices.get(id)
    if (!choice) {
      pending.push({ kind: 'paper', id, key: paper.key, trashedBy: paper.trashedBy })
      continue
    }
    // Choosing the machine that edited the paper keeps it.
    for (const edit of await paperEdits(repo, merged, paper, choice !== paper.trashedBy, c)) edits.set(edit.path, edit)
  }

  const paperKeys = new Set(papers.map((p) => p.key))
  for (const x of merged.conflicts) {
    const key = PAPER_PATH.exec(x.path.slice(repo.prefix.length))?.[1]
    // Decided (or waiting) with its paper.
    if (key && paperKeys.has(key)) continue
    const auto = await autoMerged(repo, x)
    if (auto) {
      edits.set(x.path, auto)
      continue
    }
    const id = fileConflictId(x.path)
    const choice = c.choices.get(id)
    if (choice) edits.set(x.path, sideEdit(x.path, choice === 'ours' ? x.ours : x.theirs))
    else pending.push({ kind: 'file', id, path: x.path, base: x.base, ours: x.ours, theirs: x.theirs })
  }

  if (pending.length > 0) return { kind: 'decisions', conflicts: pending }
  return { kind: 'clean', tree: edits.size > 0 ? await repo.editTree(merged.tree, [...edits.values()]) : merged.tree }
}
