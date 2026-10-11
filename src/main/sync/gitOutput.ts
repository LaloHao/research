/** Pure readers of git's NUL-separated (`-z`) output. Paths are always from the repository root. */

export interface TreeEntry {
  mode: string
  oid: string
}

export interface StageEntry extends TreeEntry {
  stage: 1 | 2 | 3
  path: string
}

/** One conflicted path of a merge: its merge-base, this side's and the other side's entries (null: absent there). */
export interface ConflictPaths {
  path: string
  base: TreeEntry | null
  ours: TreeEntry | null
  theirs: TreeEntry | null
}

export interface LsTreeEntry extends TreeEntry {
  type: string
  path: string
}

export interface NameStatus {
  status: string
  path: string
}

export function splitNul(out: string): string[] {
  return out.split('\0').filter((part) => part !== '')
}

const STAGE_LINE = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t([\s\S]+)$/

/** `git merge-tree --write-tree -z --no-messages`: the result tree, then `<mode> <oid> <stage>\t<path>` per conflicted stage. */
export function parseMergeTree(out: string): { tree: string; entries: StageEntry[] } {
  const [tree = '', ...rest] = out.split('\0')
  const entries: StageEntry[] = []
  for (const part of rest) {
    const m = STAGE_LINE.exec(part)
    if (m) entries.push({ mode: m[1], oid: m[2], stage: Number(m[3]) as 1 | 2 | 3, path: m[4] })
  }
  return { tree: tree.trim(), entries }
}

export function groupConflicts(entries: StageEntry[]): ConflictPaths[] {
  const byPath = new Map<string, ConflictPaths>()
  for (const e of entries) {
    const c = byPath.get(e.path) ?? { path: e.path, base: null, ours: null, theirs: null }
    const entry: TreeEntry = { mode: e.mode, oid: e.oid }
    if (e.stage === 1) c.base = entry
    else if (e.stage === 2) c.ours = entry
    else c.theirs = entry
    byPath.set(e.path, c)
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** `git status --porcelain=v1 -z`: every path listed, both paths of a rename or copy. */
export function parseStatus(out: string): string[] {
  const parts = out.split('\0')
  const paths: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.length < 4) continue
    const xy = part.slice(0, 2)
    paths.push(part.slice(3))
    // The origin of a rename or copy follows as its own field.
    if ((xy.includes('R') || xy.includes('C')) && i + 1 < parts.length) paths.push(parts[++i])
  }
  return paths
}

/** `git diff --name-status -z --no-renames`: status and path alternate. */
export function parseNameStatus(out: string): NameStatus[] {
  const parts = splitNul(out)
  const list: NameStatus[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) list.push({ status: parts[i], path: parts[i + 1] })
  return list
}

const LS_TREE_LINE = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t([\s\S]+)$/

/** `git ls-tree -r -z --full-tree`. */
export function parseLsTree(out: string): LsTreeEntry[] {
  return splitNul(out).flatMap((part) => {
    const m = LS_TREE_LINE.exec(part)
    return m ? [{ mode: m[1], type: m[2], oid: m[3], path: m[4] }] : []
  })
}

/** git's own rule: a NUL byte in the first 8000 bytes means binary. */
export function looksBinary(data: Uint8Array): boolean {
  return data.subarray(0, 8000).includes(0)
}
