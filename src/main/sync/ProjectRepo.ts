import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Git, GitError, NETWORK_TIMEOUT_MS, type GitOptions } from './Git'
import {
  groupConflicts,
  looksBinary,
  parseLsTree,
  parseMergeTree,
  parseNameStatus,
  parseStatus,
  splitNul,
  type ConflictPaths,
  type LsTreeEntry,
  type NameStatus
} from './gitOutput'

/** A change to a tree: put a blob at `path`, or remove whatever is there. */
export type TreeEdit = { path: string; mode: string; oid: string } | { path: string; remove: true }

export interface Upstream {
  remote: string
  /** The branch on the remote, e.g. `refs/heads/main`. */
  ref: string
  /** e.g. `origin/main`. */
  short: string
}

export interface RepoInfo {
  /** null: HEAD is detached. */
  branch: string | null
  upstream: Upstream | null
  remotes: string[]
}

export interface MergeResult {
  /** The merged tree; a conflicted file holds git's markers there (never in the working tree). */
  tree: string
  conflicts: ConflictPaths[]
}

/** A merge, rebase, cherry-pick or revert started by hand and not finished. */
const IN_PROGRESS = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']

/**
 * git plumbing for one project folder, which is the repository's root or a folder inside it (`prefix`, e.g. `research/`).
 * Every command runs at the repository root; every path in and out is from that root.
 */
export class ProjectRepo {
  private constructor(
    readonly git: Git,
    readonly top: string,
    readonly prefix: string,
    readonly gitDir: string
  ) {}

  /** The repository holding `root` (at it or in a folder above it); null outside git. */
  static async open(root: string, opts: GitOptions = {}): Promise<ProjectRepo | null> {
    let out: string
    try {
      out = await new Git(root, opts).text(['rev-parse', '--show-toplevel', '--show-prefix', '--absolute-git-dir'])
    } catch (error) {
      if (error instanceof GitError && error.kind === 'not_a_repo') return null
      throw error
    }
    const [top, prefix, gitDir] = out.split('\n')
    return new ProjectRepo(new Git(top, opts), top, prefix, gitDir)
  }

  /** `git init` in the project folder, on branch main. */
  static async init(root: string, opts: GitOptions = {}): Promise<void> {
    await new Git(root, opts).run(['init', '--quiet', '--initial-branch=main'])
  }

  /** The project folder as a pathspec from the root. */
  private get spec(): string {
    return this.prefix === '' ? '.' : this.prefix
  }

  /** `.cache/` is rebuildable: it never counts as a change to sync. */
  private get cacheExclude(): string {
    return `:(exclude)${this.prefix}.cache`
  }

  async info(): Promise<RepoInfo> {
    const symbolic = await this.git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [1] })
    const branch = symbolic.code === 0 ? symbolic.stdout.toString('utf8').trim() : null
    const remotes = (await this.git.text(['remote'])).split('\n').filter(Boolean).sort()
    return { branch, upstream: branch ? await this.upstreamOf(branch) : null, remotes }
  }

  /** Read from the config, so it works before the first commit or the first fetch. */
  private async upstreamOf(branch: string): Promise<Upstream | null> {
    const remote = await this.config(`branch.${branch}.remote`)
    const ref = await this.config(`branch.${branch}.merge`)
    if (!remote || !ref || remote === '.') return null
    return { remote, ref, short: `${remote}/${ref.replace(/^refs\/heads\//, '')}` }
  }

  private async config(key: string): Promise<string | null> {
    const out = await this.git.run(['config', '--get', key], { okCodes: [1] })
    return out.code === 0 ? out.stdout.toString('utf8').trim() : null
  }

  async setUpstream(branch: string, remote: string): Promise<void> {
    await this.git.run(['config', `branch.${branch}.remote`, remote])
    await this.git.run(['config', `branch.${branch}.merge`, `refs/heads/${branch}`])
  }

  /** `url` is what the user typed (checked by `isRemoteUrl`); `--` keeps git from ever reading it as an option. */
  async addRemote(name: string, url: string): Promise<void> {
    await this.git.run(['remote', 'add', '--', name, url])
  }

  async lfsAvailable(): Promise<boolean> {
    try {
      await this.git.run(['lfs', 'version'])
      return true
    } catch {
      return false
    }
  }

  async installLfs(): Promise<void> {
    await this.git.run(['lfs', 'install', '--local'])
  }

  async operationInProgress(): Promise<boolean> {
    for (const name of IN_PROGRESS) {
      const path = (await this.git.text(['rev-parse', '--git-path', name])).trim()
      if (existsSync(isAbsolute(path) ? path : join(this.top, path))) return true
    }
    return false
  }

  /** Files left with conflicts in the index by a merge done by hand. */
  async hasUnmerged(): Promise<boolean> {
    return (await this.git.run(['ls-files', '--unmerged', '-z'])).stdout.length > 0
  }

  /** The commit `rev` names; null when there is none (no HEAD yet, no upstream). */
  async revParse(rev: string): Promise<string | null> {
    const out = await this.git.run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { okCodes: [1, 128] })
    return out.code === 0 ? out.stdout.toString('utf8').trim() : null
  }

  async oidAt(commit: string, path: string): Promise<string | null> {
    const out = await this.git.run(['rev-parse', '--verify', '--quiet', `${commit}:${path}`], { okCodes: [1, 128] })
    return out.code === 0 ? out.stdout.toString('utf8').trim() : null
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    return (await this.git.run(['merge-base', '--is-ancestor', a, b], { okCodes: [1] })).code === 0
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const out = await this.git.run(['merge-base', a, b], { okCodes: [1] })
    return out.code === 0 ? out.stdout.toString('utf8').trim() : null
  }

  /** Uncommitted changes (new files included) inside the project folder. */
  async dirtyInProject(): Promise<boolean> {
    const out = await this.git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', this.spec, this.cacheExclude])
    return out.stdout.length > 0
  }

  /** Local commits the upstream does not have (all of them before the first push). */
  async aheadCount(): Promise<number> {
    if (!(await this.revParse('HEAD'))) return 0
    const range = (await this.revParse('@{upstream}')) ? '@{upstream}..HEAD' : 'HEAD'
    return Number((await this.git.text(['rev-list', '--count', range])).trim())
  }

  /**
   * Commits every change inside the project folder (new, edited and deleted files, honoring .gitignore) and nothing
   * else: the commit is built in a temporary index, so what the user staged or edited outside the project stays exactly
   * as it was. The branch moves with `update-ref <new> <old>` (forward only), then the real index catches up for the
   * project's paths. Returns the committed paths, or null when there was nothing to commit.
   */
  async commitProject(message: (paths: string[]) => string): Promise<string[] | null> {
    const index = join(this.gitDir, 'research-sync.index')
    const env = { GIT_INDEX_FILE: index }
    await rm(index, { force: true })
    try {
      const head = await this.revParse('HEAD')
      await this.git.run(head ? ['read-tree', head] : ['read-tree', '--empty'], { env })
      await this.git.run(['add', '--all', '--', this.spec], { env })
      // Named in `add`, an ignored .cache/ would make git fail; taken out of the temporary index instead, so it never
      // enters a commit even if someone removed it from .gitignore.
      await this.git.run(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', `${this.prefix}.cache`], { env })
      const paths = splitNul((await this.git.run(['diff', '--cached', '--name-only', '-z', '--no-renames'], { env })).stdout.toString('utf8'))
      if (paths.length === 0) return null
      const tree = (await this.git.text(['write-tree'], { env })).trim()
      const commit = await this.commitTree(tree, head ? [head] : [], message(paths))
      await this.git.run(['update-ref', '-m', 'research: sync', 'HEAD', commit, head ?? ''])
      await this.git.run(['reset', '--quiet', '--', this.spec])
      return paths
    } finally {
      await rm(index, { force: true })
    }
  }

  async fetch(remote: string, signal?: AbortSignal): Promise<void> {
    await this.git.run(['fetch', '--quiet', remote], { timeoutMs: NETWORK_TIMEOUT_MS, signal })
  }

  /** A plain push of HEAD to `ref` (never forced); `--porcelain` puts a rejection's reason where it can be classified. */
  async push(remote: string, ref: string, opts: { setUpstream?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const args = ['push', '--porcelain', ...(opts.setUpstream ? ['--set-upstream'] : []), remote, `HEAD:${ref}`]
    await this.git.run(args, { timeoutMs: NETWORK_TIMEOUT_MS, signal: opts.signal })
  }

  /** The merge of two commits, computed apart from the working tree and the index. */
  async mergeTree(ours: string, theirs: string): Promise<MergeResult> {
    const out = await this.git.run(['merge-tree', '--write-tree', '-z', '--no-messages', ours, theirs], { okCodes: [1] })
    const parsed = parseMergeTree(out.stdout.toString('utf8'))
    return { tree: parsed.tree, conflicts: groupConflicts(parsed.entries) }
  }

  async readBlob(oid: string): Promise<Buffer> {
    return (await this.git.run(['cat-file', 'blob', oid])).stdout
  }

  async readText(oid: string): Promise<string> {
    return (await this.readBlob(oid)).toString('utf8')
  }

  /** A file as a commit (or tree) has it; null when it is not there. */
  async readFileAt(commit: string, path: string): Promise<Buffer | null> {
    const out = await this.git.run(['cat-file', 'blob', `${commit}:${path}`], { okCodes: [128] })
    return out.code === 0 ? out.stdout : null
  }

  /** A blob for the side-by-side view, or why it cannot be shown. */
  async blobText(oid: string, max: number): Promise<{ text: string } | { unavailable: 'binary' | 'too_large' }> {
    const size = Number((await this.git.text(['cat-file', '-s', oid])).trim())
    if (size > max) return { unavailable: 'too_large' }
    const data = await this.readBlob(oid)
    return looksBinary(data) ? { unavailable: 'binary' } : { text: data.toString('utf8') }
  }

  /** Stores `data` as a blob, byte for byte (no filters). */
  async writeBlob(data: string | Uint8Array): Promise<string> {
    return (await this.git.text(['hash-object', '-w', '--stdin', '--no-filters'], { input: data })).trim()
  }

  /** Every file under `dirs` (from the root; `.` for all) in a commit or tree. */
  async lsTree(treeish: string, dirs: string[]): Promise<LsTreeEntry[]> {
    const out = await this.git.run(['ls-tree', '-r', '-z', '--full-tree', treeish, '--', ...dirs])
    return parseLsTree(out.stdout.toString('utf8'))
  }

  /** `base` with `edits` applied, written as a new tree through a temporary index. */
  async editTree(base: string, edits: TreeEdit[]): Promise<string> {
    const index = join(this.gitDir, 'research-merge.index')
    const env = { GIT_INDEX_FILE: index }
    await rm(index, { force: true })
    try {
      await this.git.run(['read-tree', base], { env })
      const zero = '0'.repeat(base.length)
      const input = edits.map((e) => ('remove' in e ? `0 ${zero}\t${e.path}` : `${e.mode} ${e.oid}\t${e.path}`)).join('\0')
      await this.git.run(['update-index', '-z', '--index-info'], { env, input: `${input}\0` })
      return (await this.git.text(['write-tree'], { env })).trim()
    } finally {
      await rm(index, { force: true })
    }
  }

  /** A commit of `tree` with the user's git identity (commit hooks do not run). */
  async commitTree(tree: string, parents: string[], message: string): Promise<string> {
    const args = ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-']
    return (await this.git.text(args, { input: message })).trim()
  }

  async nameStatus(from: string, to: string, dirs: string[]): Promise<NameStatus[]> {
    const out = await this.git.run(['diff', '--name-status', '-z', '--no-renames', from, to, '--', ...dirs])
    return parseNameStatus(out.stdout.toString('utf8'))
  }

  /**
   * Local files (staged, unstaged, untracked or ignored) that moving from `from` to `to` would overwrite: a fast-forward
   * must stop instead (git itself would overwrite an ignored file without asking).
   */
  async blockedPaths(from: string, to: string): Promise<string[]> {
    const changed = splitNul((await this.git.run(['diff', '--name-only', '-z', '--no-renames', from, to])).stdout.toString('utf8'))
    const local = parseStatus((await this.git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'])).stdout.toString('utf8'))
    const hit = (path: string): boolean => (path.endsWith('/') ? changed.some((c) => c.startsWith(path)) : changed.includes(path))
    return [...new Set(local.filter(hit))].sort()
  }

  /** Moves the branch and the working tree to `target`, a descendant of HEAD. */
  async fastForward(target: string): Promise<void> {
    await this.git.run(['merge', '--ff-only', '--quiet', target])
  }
}
