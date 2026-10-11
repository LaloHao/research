import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { parse } from 'yaml'
import type { PdfPolicy } from '../../shared/schemas'
import {
  isRemoteUrl,
  type ConflictChoice,
  type ConflictDecision,
  type ConflictDiff,
  type ConflictItem,
  type ConflictSide,
  type DiffFile,
  type SyncError,
  type SyncErrorCode,
  type SyncPhase,
  type SyncResult,
  type SyncSetup,
  type SyncStatus
} from '../../shared/sync'
import { GitError, type GitOptions } from './Git'
import type { TreeEntry } from './gitOutput'
import { mergeCommitMessage, syncCommitMessage } from './messages'
import { ProjectRepo, type RepoInfo, type Upstream } from './ProjectRepo'
import { planMerge, type MergePlan, type PendingConflict } from './syncMerge'

/** Larger files are not shown side by side. */
export const MAX_DIFF_BYTES = 512 * 1024

export interface SyncServiceDeps {
  /** The project folder: the repository's root or a folder inside it. */
  root: string
  /** ProjectStore's write gate, taken exclusively for the local steps (commit, merge, checkout); never while online. */
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>
  pdfPolicy: () => PdfPolicy
  /** A paper's title from the index, for the conflicts panel (falls back to the paper.yaml in the commits). */
  paperTitle?: (key: string) => string | null
  /** Names this machine in commit messages; defaults to the host name. */
  machineName?: string
  /** The state changed (phase, conflicts, last sync, error). */
  emit?: () => void
  /** Extra environment for git, and another git binary: tests only. */
  gitEnv?: Record<string, string>
  gitBin?: string
  now?: () => Date
}

const SETUP_ERRORS: Record<Exclude<SyncSetup, 'ready'>, SyncErrorCode> = {
  no_git: 'git_missing',
  no_repo: 'not_a_repo',
  no_remote: 'no_remote',
  no_upstream: 'no_upstream'
}
/** An automatic sync ends quietly on these: the project simply is not set up to sync (yet). */
const QUIET_FOR_AUTO = new Set<SyncErrorCode>(Object.values(SETUP_ERRORS))

const PAPER_PATH = /^(?:papers|\.trash)\/([a-z][a-z0-9]*)\//

class SyncFailure extends Error {
  constructor(readonly error: SyncError) {
    super(error.code)
    this.name = 'SyncFailure'
  }
}

function fail(code: SyncErrorCode, paths: string[] = []): never {
  throw new SyncFailure({ code, paths })
}

function toSyncError(error: unknown): SyncError {
  if (error instanceof SyncFailure) return error.error
  if (error instanceof GitError) {
    if (error.kind === 'git_failed') console.error('sync', error.message)
    return { code: error.kind === 'push_behind' ? 'push_rejected' : error.kind, paths: [] }
  }
  console.error('sync', error)
  return { code: 'git_failed', paths: [] }
}

const side = (base: TreeEntry | null, entry: TreeEntry | null): ConflictSide => (entry === null ? 'deleted' : base === null ? 'added' : 'modified')

/** A choice bound to the versions the user saw when making it. */
interface Decided {
  choice: ConflictChoice
  fingerprint: string
}

interface Commits {
  ours: string
  theirs: string
  base: string
}

interface Pending {
  head: string
  theirs: string
  base: string
  conflicts: PendingConflict[]
  /** What each listed conflict looks like (its versions), by id: a choice applies only to these exact versions. */
  fingerprints: Map<string, string>
  /** Choices already made that still match their conflict; they carry over to the next «Terminar sincronización». */
  decided: Map<string, Decided>
}

/**
 * The versions a conflict is about: a file's base, mine and theirs; for a paper, who trashed it and its library and
 * trash folders in the three commits. A choice is reused only while this stays the same.
 */
async function fingerprint(repo: ProjectRepo, c: PendingConflict, commits: Commits): Promise<string> {
  const entry = (e: TreeEntry | null): string => (e ? `${e.mode}:${e.oid}` : '-')
  if (c.kind === 'file') return `file ${entry(c.base)} ${entry(c.ours)} ${entry(c.theirs)}`
  const parts = [`paper ${c.trashedBy}`]
  for (const commit of [commits.base, commits.ours, commits.theirs]) {
    for (const folder of ['papers', '.trash']) parts.push((await repo.oidAt(commit, `${repo.prefix}${folder}/${c.key}`)) ?? '-')
  }
  return parts.join(' ')
}

/** The short hash of a fingerprint the renderer sees as `ConflictItem.version`. */
function conflictVersion(fingerprint: string): string {
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)
}

interface Ready {
  repo: ProjectRepo
  upstream: Upstream
}

/**
 * Syncs the project folder with its git remote: local commit, fetch, a merge computed apart from the working tree,
 * fast-forward, push. One sync at a time; decisions wait in memory with the working tree untouched.
 */
export class SyncService {
  private phase: SyncPhase = 'idle'
  private lastSyncAt: string | null = null
  private error: SyncError | null = null
  private errorAuto = false
  private pending: Pending | null = null
  private running: Promise<SyncResult> | null = null
  /** Whether `running` is an automatic sync. */
  private runningAuto = false
  /** A manual sync waiting for a running automatic one to end; later manual callers share it. */
  private queuedManual: Promise<SyncResult> | null = null
  private readonly stopping = new AbortController()

  constructor(private readonly deps: SyncServiceDeps) {}

  get hasConflicts(): boolean {
    return this.pending !== null
  }

  private get gitOptions(): GitOptions {
    return { env: this.deps.gitEnv, bin: this.deps.gitBin }
  }

  private get machine(): string {
    return this.deps.machineName ?? hostname()
  }

  async status(): Promise<SyncStatus> {
    let inspected: Awaited<ReturnType<SyncService['inspect']>>
    try {
      inspected = await this.inspect()
    } catch (error) {
      // An unplugged drive or a deleted folder: nothing to read, and nothing to set up either.
      if (!(error instanceof GitError) || error.kind !== 'project_missing') throw error
      return {
        setup: 'no_repo',
        phase: this.phase === 'syncing' ? 'syncing' : 'error',
        lastSyncAt: this.lastSyncAt,
        dirty: false,
        ahead: 0,
        error: { code: 'project_missing', paths: [] },
        errorAuto: this.error?.code === 'project_missing' ? this.errorAuto : false,
        conflicts: this.pending?.conflicts.length ?? 0,
        repoRoot: null,
        branch: null,
        upstream: null
      }
    }
    const { setup, repo, info } = inspected
    const dirty = repo ? await repo.dirtyInProject() : false
    const ahead = repo && info?.upstream ? await repo.aheadCount() : 0
    return {
      setup,
      phase: this.phase,
      lastSyncAt: this.lastSyncAt,
      dirty,
      ahead,
      error: this.error,
      errorAuto: this.errorAuto,
      conflicts: this.pending?.conflicts.length ?? 0,
      repoRoot: repo?.top ?? null,
      branch: info?.branch ?? null,
      upstream: info?.upstream?.short ?? null
    }
  }

  /**
   * Something to sync before closing: changes not committed or not pushed, or decisions waiting, in a project with a
   * remote. A state that cannot be read counts as nothing to sync, so it never keeps the window from closing.
   */
  async hasUnsynced(): Promise<boolean> {
    try {
      const s = await this.status()
      return s.setup === 'ready' && (s.dirty || s.ahead > 0 || s.conflicts > 0)
    } catch (error) {
      console.error('sync', error)
      return false
    }
  }

  /**
   * «Sincronizar», or the automatic sync (which leaves a pending decision alone). A sync already running is joined,
   * except that a manual one never joins an automatic one: that may be past its last commit, so edits saved since
   * (e.g. flushed right before «Sincronizar y cerrar») would not be in what it reports as synced. The manual sync
   * waits for it and then runs its own cycle; manual callers arriving meanwhile share that cycle.
   * Choices already made for conflicts that have not changed carry over.
   */
  run(opts: { auto: boolean }): Promise<SyncResult> {
    if (this.running) {
      if (opts.auto || !this.runningAuto) return this.running
      this.queuedManual ??= this.running
        .catch(() => undefined)
        .then(() => {
          this.queuedManual = null
          return this.run({ auto: false })
        })
      return this.queuedManual
    }
    if (this.closed) return this.refused()
    if (opts.auto && this.pending) return Promise.resolve({ ok: true, outcome: 'conflicts' })
    const decided = new Map(this.pending?.decided)
    return this.start(() => this.cycle(decided), opts.auto)
  }

  /**
   * «Terminar sincronización»: merges with the choices, each bound to the versions listed now. A decision still missing,
   * a new one, or one whose versions changed since (a newer local save, the remote moving) keeps the conflicts open.
   * While a sync runs the choices are not taken: the caller gets that sync's result (the UI disables the button).
   */
  resolve(choices: Readonly<Record<string, ConflictDecision>>): Promise<SyncResult> {
    if (this.running) return this.running
    if (this.closed) return this.refused()
    const pending = this.pending
    if (!pending) return this.run({ auto: false })
    const decided = new Map(pending.decided)
    for (const [id, { choice, version }] of Object.entries(choices)) {
      // A choice made for versions a later sync replaced (same id, new version) is not taken: that conflict stays open.
      const seen = pending.fingerprints.get(id)
      if (seen !== undefined && conflictVersion(seen) === version) decided.set(id, { choice, fingerprint: seen })
    }
    return this.start(() => this.cycle(decided, pending.theirs), false)
  }

  /** «Cancelar»: forgets the decisions; the local commit stays, unpushed. A no-op while a sync runs (the UI disables it). */
  abort(): void {
    if (this.running || !this.pending) return
    this.pending = null
    this.phase = 'idle'
    this.emit()
  }

  /**
   * First use: `git init` when the folder is not in a repository, `url` as origin when given, then the first sync
   * (following the remote's branch when it exists, publishing this one otherwise). While a sync runs the URL is not
   * taken: the caller gets that sync's result.
   */
  setup(url: string | null): Promise<SyncResult> {
    if (this.running) return this.running
    if (this.closed) return this.refused()
    return this.start(async () => {
      // Checked here too, whoever calls: a password must never reach .git/config.
      if (url !== null && !isRemoteUrl(url)) fail('invalid_remote_url')
      let repo = await ProjectRepo.open(this.deps.root, this.gitOptions)
      if (!repo) {
        await ProjectRepo.init(this.deps.root, this.gitOptions)
        repo = (await ProjectRepo.open(this.deps.root, this.gitOptions)) ?? fail('not_a_repo')
        if (this.deps.pdfPolicy() === 'lfs' && (await repo.lfsAvailable())) await repo.installLfs()
      }
      let info = await repo.info()
      // Before anything commits: connecting runs the first local commit.
      await this.checkClean(repo, info)
      if (url !== null) {
        if (!info.remotes.includes('origin')) {
          await repo.addRemote('origin', url)
          info = await repo.info()
        } else if ((await repo.remoteUrl('origin')) !== url) {
          // The same URL again is a retry (e.g. after the first attempt went offline). Another one corrects a mistyped
          // URL only while origin never worked: never fetched and followed by no branch. A working origin (other
          // branches may follow it) is the user's to change with git.
          if (info.upstream || (await repo.remoteInUse('origin'))) fail('remote_exists')
          await repo.setRemoteUrl('origin', url)
        }
      }
      if (info.remotes.length === 0) return { ok: false, error: { code: 'no_remote', paths: [] } }
      if (!info.upstream) await this.connect(repo, info)
      return this.cycle(new Map())
    }, false)
  }

  async conflicts(): Promise<ConflictItem[]> {
    const pending = this.pending
    if (!pending) return []
    const repo = await this.openRepo()
    const items: ConflictItem[] = []
    for (const c of pending.conflicts) items.push(await this.item(repo, pending, c))
    return items
  }

  /** Both versions of a conflicted file, or of every file the editing machine changed in a paper the other trashed. */
  async diff(id: string): Promise<ConflictDiff> {
    const pending = this.pending
    const c = pending?.conflicts.find((x) => x.id === id)
    if (!pending || !c) return { files: [] }
    const repo = await this.openRepo()
    if (c.kind === 'file') return { files: [await diffFile(repo, c.path.slice(repo.prefix.length), c.ours?.oid ?? null, c.theirs?.oid ?? null)] }
    const kept = c.trashedBy === 'ours' ? pending.theirs : pending.head
    const trashed = c.trashedBy === 'ours' ? pending.head : pending.theirs
    const folder = `${repo.prefix}papers/${c.key}/`
    const files: DiffFile[] = []
    for (const change of await repo.nameStatus(pending.base, kept, [folder])) {
      const name = change.path.slice(folder.length)
      const keptOid = await repo.oidAt(kept, change.path)
      const trashedOid = await repo.oidAt(trashed, `${repo.prefix}.trash/${c.key}/${name}`)
      const [ours, theirs] = c.trashedBy === 'ours' ? [trashedOid, keptOid] : [keptOid, trashedOid]
      files.push(await diffFile(repo, `papers/${c.key}/${name}`, ours, theirs))
    }
    return { files }
  }

  /** The project is closing: cuts a fetch or push short and waits for the sync to end; no sync starts after it. */
  async close(): Promise<void> {
    this.stopping.abort()
    await this.running?.catch(() => undefined)
  }

  private get closed(): boolean {
    return this.stopping.signal.aborted
  }

  private refused(): Promise<SyncResult> {
    return Promise.resolve({ ok: false, error: { code: 'cancelled', paths: [] } })
  }

  /** Between steps: a close cuts the sync short even where git itself would not notice (a step about to start). */
  private checkOpen(): void {
    if (this.closed) fail('cancelled')
  }

  private start(work: () => Promise<SyncResult>, auto: boolean): Promise<SyncResult> {
    this.phase = 'syncing'
    this.runningAuto = auto
    this.emit()
    const run = (async (): Promise<SyncResult> => {
      try {
        const result = await work()
        this.error = null
        this.errorAuto = false
        if (result.ok && result.outcome === 'synced') this.lastSyncAt = (this.deps.now?.() ?? new Date()).toISOString()
        this.phase = this.pending ? 'conflicts' : 'idle'
        return result
      } catch (caught) {
        const error = toSyncError(caught)
        if (auto && QUIET_FOR_AUTO.has(error.code)) {
          this.phase = this.pending ? 'conflicts' : 'idle'
        } else {
          this.error = error
          this.errorAuto = auto
          this.phase = 'error'
        }
        return { ok: false, error }
      } finally {
        this.running = null
        this.runningAuto = false
        this.emit()
      }
    })()
    this.running = run
    return run
  }

  /** Commit, fetch, merge and push; a push refused because the remote moved meanwhile goes round once more. */
  private async cycle(decided: ReadonlyMap<string, Decided>, knownTheirs?: string): Promise<SyncResult> {
    const { repo, upstream } = await this.ready()
    // Before going online: offline, the work is still saved in a local commit.
    await this.deps.exclusive(() => this.commitLocal(repo))
    for (let attempt = 0; ; attempt++) {
      let theirs: string | null
      if (attempt === 0 && knownTheirs) {
        theirs = knownTheirs
      } else {
        this.checkOpen()
        await repo.fetch(upstream.remote, this.stopping.signal)
        theirs = await repo.revParse('@{upstream}')
      }
      this.checkOpen()
      // On the retry the same choices are offered again: each one only applies to a conflict that has not changed.
      if ((await this.integrate(repo, theirs, decided)) === 'conflicts') return { ok: true, outcome: 'conflicts' }
      if ((await repo.aheadCount()) === 0) return { ok: true, outcome: 'synced' }
      this.checkOpen()
      try {
        await repo.push(upstream.remote, upstream.ref, { signal: this.stopping.signal })
        return { ok: true, outcome: 'synced' }
      } catch (error) {
        if (!(error instanceof GitError) || error.kind !== 'push_behind') throw error
        if (attempt > 0) fail('push_rejected')
      }
    }
  }

  /**
   * Brings the remote's commits in without touching the working tree until the result is complete: nothing to do, a
   * fast-forward, a merge commit, or decisions to make (then nothing changes on disk).
   */
  private integrate(repo: ProjectRepo, theirs: string | null, decided: ReadonlyMap<string, Decided>): Promise<'done' | 'conflicts'> {
    return this.deps.exclusive(async () => {
      // What the app wrote while fetching joins the local commit first.
      await this.commitLocal(repo)
      const head = await repo.revParse('HEAD')
      if (!theirs || (head && (await repo.isAncestor(theirs, head)))) {
        this.pending = null
        return 'done'
      }
      let target = theirs
      if (head && !(await repo.isAncestor(head, theirs))) {
        const base = (await repo.mergeBase(head, theirs)) ?? fail('unrelated_histories')
        const commits = { ours: head, theirs, base }
        const { plan, kept } = await this.plan(repo, commits, decided)
        if (plan.kind === 'outside') fail('conflict_outside', plan.paths)
        if (plan.kind === 'decisions') {
          const fingerprints = new Map<string, string>()
          for (const c of plan.conflicts) fingerprints.set(c.id, await fingerprint(repo, c, commits))
          this.pending = { head, theirs, base, conflicts: plan.conflicts, fingerprints, decided: kept }
          return 'conflicts'
        }
        target = await repo.commitTree(plan.tree, [head, theirs], mergeCommitMessage(this.machine))
      }
      const blocked = head ? await repo.blockedPaths(head, target) : []
      if (blocked.length > 0) fail('local_changes_block', blocked)
      await repo.fastForward(target)
      this.pending = null
      return 'done'
    })
  }

  /**
   * The merge with the choices that still fit: the conflicts are listed first without any, and a choice is applied only
   * when its conflict is still there with the versions the user saw. A dropped choice leaves that conflict open.
   */
  private async plan(repo: ProjectRepo, commits: Commits, decided: ReadonlyMap<string, Decided>): Promise<{ plan: MergePlan; kept: Map<string, Decided> }> {
    const open = await planMerge(repo, { ...commits, choices: new Map() })
    const kept = new Map<string, Decided>()
    if (open.kind !== 'decisions' || decided.size === 0) return { plan: open, kept }
    for (const c of open.conflicts) {
      const d = decided.get(c.id)
      if (d && d.fingerprint === (await fingerprint(repo, c, commits))) kept.set(c.id, d)
    }
    if (kept.size === 0) return { plan: open, kept }
    const choices = new Map([...kept].map(([id, d]) => [id, d.choice]))
    return { plan: await planMerge(repo, { ...commits, choices }), kept }
  }

  private async commitLocal(repo: ProjectRepo): Promise<void> {
    await repo.commitProject((paths) => syncCommitMessage(this.machine, paths, repo.prefix))
  }

  private async inspect(): Promise<{ setup: SyncSetup; repo: ProjectRepo | null; info: RepoInfo | null }> {
    let repo: ProjectRepo | null
    try {
      repo = await ProjectRepo.open(this.deps.root, this.gitOptions)
    } catch (error) {
      if (error instanceof GitError && error.kind === 'git_missing') return { setup: 'no_git', repo: null, info: null }
      throw error
    }
    if (!repo) return { setup: 'no_repo', repo: null, info: null }
    const info = await repo.info()
    return { setup: info.upstream ? 'ready' : info.remotes.length > 0 ? 'no_upstream' : 'no_remote', repo, info }
  }

  /** The checks before a sync: git, a repository, a branch with an upstream, nothing half-done by hand, git-lfs when needed. */
  private async ready(): Promise<Ready> {
    const { setup, repo, info } = await this.inspect()
    if (!repo || !info) fail(setup === 'ready' ? 'not_a_repo' : SETUP_ERRORS[setup])
    // Before the setup: a detached HEAD has no upstream either, and that is not what needs fixing.
    if (!info.branch) fail('detached_head')
    const upstream = info.upstream
    if (setup !== 'ready' || !upstream) fail(setup === 'ready' ? 'no_upstream' : SETUP_ERRORS[setup])
    await this.checkClean(repo, info)
    if (this.deps.pdfPolicy() === 'lfs' && !(await repo.lfsAvailable())) fail('lfs_missing')
    return { repo, upstream }
  }

  /** Nothing the app could commit over: a branch checked out, and no merge (or rebase…) left half-done by hand. */
  private async checkClean(repo: ProjectRepo, info: RepoInfo): Promise<void> {
    if (!info.branch) fail('detached_head')
    if (await repo.operationInProgress()) fail('merge_in_progress')
    if (await repo.hasUnmerged()) fail('unmerged_files')
  }

  /** First sync of a branch: follow the remote's branch of the same name when it exists, otherwise publish this one. */
  private async connect(repo: ProjectRepo, info: RepoInfo): Promise<void> {
    const branch = info.branch ?? fail('detached_head')
    const remote = info.remotes.includes('origin') ? 'origin' : info.remotes[0]
    await this.deps.exclusive(() => this.commitLocal(repo))
    this.checkOpen()
    await repo.fetch(remote, this.stopping.signal)
    const remoteHead = await repo.revParse(`refs/remotes/${remote}/${branch}`)
    const head = await repo.revParse('HEAD')
    // Another project's history: stop before following it, so the branch is left without an upstream to retry.
    if (remoteHead && head && !(await repo.mergeBase(head, remoteHead))) fail('unrelated_histories')
    await repo.setUpstream(branch, remote)
    if (!remoteHead) {
      this.checkOpen()
      await repo.push(remote, `refs/heads/${branch}`, { signal: this.stopping.signal })
    }
  }

  private async openRepo(): Promise<ProjectRepo> {
    return (await ProjectRepo.open(this.deps.root, this.gitOptions)) ?? fail('not_a_repo')
  }

  private async item(repo: ProjectRepo, pending: Pending, c: PendingConflict): Promise<ConflictItem> {
    if (c.kind === 'paper') {
      return {
        id: c.id,
        kind: 'paper',
        path: `papers/${c.key}/`,
        paperId: c.key,
        paperTitle: await this.title(repo, pending, c.key),
        ours: c.trashedBy === 'ours' ? 'trashed' : 'edited',
        theirs: c.trashedBy === 'theirs' ? 'trashed' : 'edited',
        version: conflictVersion(pending.fingerprints.get(c.id) ?? '')
      }
    }
    const path = c.path.slice(repo.prefix.length)
    const key = PAPER_PATH.exec(path)?.[1] ?? null
    return {
      id: c.id,
      kind: 'file',
      path,
      paperId: key,
      paperTitle: key ? await this.title(repo, pending, key) : null,
      ours: side(c.base, c.ours),
      theirs: side(c.base, c.theirs),
      version: conflictVersion(pending.fingerprints.get(c.id) ?? '')
    }
  }

  /** From the index, or from the paper.yaml either commit has (in the library or the trash). */
  private async title(repo: ProjectRepo, pending: Pending, key: string): Promise<string | null> {
    const known = this.deps.paperTitle?.(key)
    if (known) return known
    for (const commit of [pending.head, pending.theirs]) {
      for (const folder of ['papers', '.trash']) {
        const data = await repo.readFileAt(commit, `${repo.prefix}${folder}/${key}/paper.yaml`)
        if (!data) continue
        try {
          const title = (parse(data.toString('utf8')) as { title?: unknown } | null)?.title
          if (typeof title === 'string' && title.trim() !== '') return title
        } catch {
          // An unreadable paper.yaml just has no title here.
        }
      }
    }
    return null
  }

  private emit(): void {
    this.deps.emit?.()
  }
}

async function diffFile(repo: ProjectRepo, path: string, ours: string | null, theirs: string | null): Promise<DiffFile> {
  const [a, b] = await Promise.all([ours, theirs].map((oid) => (oid === null ? Promise.resolve(null) : repo.blobText(oid, MAX_DIFF_BYTES))))
  for (const s of [a, b]) if (s && 'unavailable' in s) return { path, ours: null, theirs: null, unavailable: s.unavailable }
  return { path, ours: a && 'text' in a ? a.text : null, theirs: b && 'text' in b ? b.text : null, unavailable: null }
}
