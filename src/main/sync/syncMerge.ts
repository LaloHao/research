import type { ConflictChoice } from '../../shared/sync'
import type { ConflictPaths, NameStatus, TreeEntry } from './gitOutput'
import { siblingName } from '../project/trashPaths'
import { chatIdOfPath, mergeChatText, type ChatMergeResult } from './chatMerge'
import { draftIdOfPath, mergeDraftText } from './draftMerge'
import { mergerFor, type MergeInput } from './mergers'
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

/** Where git puts a file that clashed with a folder: `<path>~<commit>`. */
const RELOCATED = /~[0-9a-f]{40,64}$/

/** The final tree as path → entry (null: removed), on top of the merged tree. */
class TreeState {
  private readonly changes = new Map<string, TreeEntry | null>()

  constructor(
    private readonly repo: ProjectRepo,
    private readonly tree: string
  ) {}

  set(path: string, entry: TreeEntry | null): void {
    this.changes.set(path, entry)
  }

  async has(path: string): Promise<boolean> {
    const change = this.changes.get(path)
    return change !== undefined ? change !== null : (await this.repo.oidAt(this.tree, path)) !== null
  }

  /** The blob at `path` in the final tree so far; null when there is none. */
  async oid(path: string): Promise<string | null> {
    const change = this.changes.get(path)
    return change !== undefined ? (change?.oid ?? null) : await this.repo.oidAt(this.tree, path)
  }

  /** The first free `<dir>/<name>.conflict[-n]` beside `path` (a `~<commit>` suffix git added taken off first). */
  async freeSibling(path: string): Promise<string> {
    const slash = path.lastIndexOf('/') + 1
    const name = path.slice(slash).replace(RELOCATED, '')
    for (let n = 1; ; n++) {
      const candidate = `${path.slice(0, slash)}${siblingName(name, 'conflict', n)}`
      if (!(await this.has(candidate))) return candidate
    }
  }

  /** Puts `entry` at `path`; a path git relocated with `~<commit>` moves to a readable sibling the app accepts. */
  async place(path: string, entry: TreeEntry | null): Promise<void> {
    if (entry && RELOCATED.test(path)) {
      this.set(path, null)
      this.set(await this.freeSibling(path), entry)
    } else {
      this.set(path, entry)
    }
  }

  edits(): TreeEdit[] {
    return [...this.changes].map(([path, entry]) => sideEdit(path, entry))
  }
}

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

/**
 * Papers one machine trashed while the other edited them (git may have merged that cleanly, carrying the edit into
 * .trash/). A paper trashed and deleted for good before the sync is not one of them: its edited files become per-file
 * decisions, and a file the other machine added stays in a library folder with no paper.yaml, which the app ignores.
 */
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
 * not merge takes the version of the machine that trashed the paper, except a file only the editing machine added: it
 * stays, like the edits git carried. Whatever is still left in the library folder then (a file git did not carry, e.g.
 * one added in a new subfolder) moves to the same place in the trashed copy, beside what is there.
 */
async function paperEdits(repo: ProjectRepo, merged: MergeResult, paper: TrashedPaper, keep: boolean, c: MergeCommits, state: TreeState): Promise<void> {
  const [library, trash] = [`${repo.prefix}papers/${paper.key}/`, `${repo.prefix}.trash/${paper.key}/`]
  if (keep) {
    const editor = paper.trashedBy === 'ours' ? c.theirs : c.ours
    for (const e of await repo.lsTree(merged.tree, [library, trash])) state.set(e.path, null)
    for (const e of await repo.lsTree(editor, [library])) state.set(e.path, { mode: e.mode, oid: e.oid })
    return
  }
  const left = new Map<string, TreeEntry | null>()
  for (const e of await repo.lsTree(merged.tree, [library])) left.set(e.path, { mode: e.mode, oid: e.oid })
  for (const x of merged.conflicts) {
    if (!x.path.startsWith(library) && !x.path.startsWith(trash)) continue
    const [trasher, editor] = paper.trashedBy === 'ours' ? [x.ours, x.theirs] : [x.theirs, x.ours]
    const entry = !x.base && !trasher ? editor : trasher
    if (x.path.startsWith(library)) left.set(x.path, entry)
    else await state.place(x.path, entry)
  }
  for (const [path, entry] of left) {
    state.set(path, null)
    if (!entry) continue
    const target = `${trash}${path.slice(library.length).replace(RELOCATED, '')}`
    state.set((await state.has(target)) ? await state.freeSibling(target) : target, entry)
  }
}

async function autoMerged(repo: ProjectRepo, x: ConflictPaths): Promise<TreeEntry | null> {
  if (!x.ours || !x.theirs) return null
  const merger = mergerFor(x.path.slice(repo.prefix.length))
  if (!merger) return null
  const text = merger({
    base: x.base ? await repo.readText(x.base.oid) : null,
    ours: await repo.readText(x.ours.oid),
    theirs: await repo.readText(x.theirs.oid)
  })
  return text === null ? null : { mode: x.ours.mode, oid: await repo.writeBlob(text) }
}

/** The files merged one per file that may split into a copy: conversations and drafts. */
const SPLITTING_MERGERS: { idOf: (relPath: string) => string | null; merge: (input: MergeInput, id: string) => ChatMergeResult | null }[] = [
  { idOf: chatIdOfPath, merge: mergeChatText },
  { idOf: draftIdOfPath, merge: mergeDraftText }
]

/**
 * chats/<id>.md and drafts/<id>.md, which never wait for a decision when both sides can be read: changed on both
 * machines they merge (or split into two, see mergeChatText and mergeDraftText); deleted on one and changed on the
 * other, the changed one stays.
 */
async function chatEdits(repo: ProjectRepo, x: ConflictPaths, state: TreeState): Promise<boolean> {
  const relPath = x.path.slice(repo.prefix.length)
  const merger = SPLITTING_MERGERS.find((m) => m.idOf(relPath) !== null)
  const id = merger?.idOf(relPath) ?? null
  if (!merger || id === null) return false
  if (!x.ours || !x.theirs) {
    const kept = x.ours ?? x.theirs
    if (!kept) return false
    state.set(x.path, kept)
    return true
  }
  const merged = merger.merge(
    {
      base: x.base ? await repo.readText(x.base.oid) : null,
      ours: await repo.readText(x.ours.oid),
      theirs: await repo.readText(x.theirs.oid)
    },
    id
  )
  if (!merged) return false
  if (merged.copy) {
    const copyPath = `${repo.prefix}${merged.copy.relPath}`
    // The same two versions always give the same copy; anything else already there is never overwritten.
    const existing = await state.oid(copyPath)
    const oid = await repo.writeBlob(merged.copy.text)
    if (existing !== null && existing !== oid) return false
    state.set(copyPath, { mode: x.ours.mode, oid })
  }
  state.set(x.path, { mode: x.ours.mode, oid: await repo.writeBlob(merged.text) })
  return true
}

/**
 * Turns `git merge-tree` into a finished tree, or the decisions still missing. A conflict outside the project folder
 * stops everything; the files the app knows how to merge are merged; the rest waits for (or applies) the user's choice.
 */
export async function planMerge(repo: ProjectRepo, c: MergeCommits): Promise<MergePlan> {
  const merged = await repo.mergeTree(c.ours, c.theirs)
  const outside = merged.conflicts.filter((x) => !x.path.startsWith(repo.prefix)).map((x) => x.path)
  if (outside.length > 0) return { kind: 'outside', paths: outside }

  const state = new TreeState(repo, merged.tree)
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
    await paperEdits(repo, merged, paper, choice !== paper.trashedBy, c, state)
  }

  const paperKeys = new Set(papers.map((p) => p.key))
  for (const x of merged.conflicts) {
    const key = PAPER_PATH.exec(x.path.slice(repo.prefix.length))?.[1]
    // Decided (or waiting) with its paper.
    if (key && paperKeys.has(key)) continue
    // Added on one side only, and relocated by git (a file/folder clash, a folder the other side renamed): the other
    // side never had it, so there is nothing to decide and nothing to drop.
    if (!x.base && (x.ours === null) !== (x.theirs === null)) {
      await state.place(x.path, x.ours ?? x.theirs)
      continue
    }
    if (await chatEdits(repo, x, state)) continue
    const auto = await autoMerged(repo, x)
    if (auto) {
      state.set(x.path, auto)
      continue
    }
    const id = fileConflictId(x.path)
    const choice = c.choices.get(id)
    if (choice) await state.place(x.path, choice === 'ours' ? x.ours : x.theirs)
    else pending.push({ kind: 'file', id, path: x.path, base: x.base, ours: x.ours, theirs: x.theirs })
  }

  if (pending.length > 0) return { kind: 'decisions', conflicts: pending }
  const edits = state.edits()
  return { kind: 'clean', tree: edits.length > 0 ? await repo.editTree(merged.tree, edits) : merged.tree }
}
