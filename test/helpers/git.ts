import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpDir } from './tmp'

export type GitEnv = Record<string, string>

/** git away from the user's own configuration (hooks path, signing, default branch), from prompts and from proxies. */
export async function isolatedGitEnv(): Promise<GitEnv> {
  const global = join(await tmpDir(), 'gitconfig')
  await writeFile(global, '')
  return { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', NO_PROXY: '*', no_proxy: '*' }
}

/** Variables that would point git at another repository or index (e.g. when the tests run from a git hook). */
const LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES']

export function runGit(env: GitEnv, cwd: string, ...args: string[]): string {
  const base = { ...process.env }
  for (const key of LOCATION_VARS) delete base[key]
  return execFileSync('git', args, { cwd, env: { ...base, ...env }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

export function identify(env: GitEnv, repo: string, name: string): void {
  runGit(env, repo, 'config', 'user.name', name)
  runGit(env, repo, 'config', 'user.email', `${name.toLowerCase().replace(/\W+/g, '-')}@example.test`)
}

/** Writes the files under `dir`; null deletes one. */
export async function applyFiles(dir: string, files: Record<string, string | null>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path)
    if (text === null) {
      await rm(full, { force: true })
    } else {
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, text)
    }
  }
}

/** What «Quitar de la biblioteca» does on disk: papers/<key>/ becomes .trash/<key>/ with its trashed.yaml. */
export async function trashOnDisk(project: string, key: string, at = '2026-10-11T12:00:00.000Z'): Promise<void> {
  await mkdir(join(project, '.trash'), { recursive: true })
  await rename(join(project, 'papers', key), join(project, '.trash', key))
  await writeFile(join(project, '.trash', key, 'trashed.yaml'), `schema_version: 1\ntrashed_at: '${at}'\ndevice: 22222222-2222-2222-2222-222222222222\n`)
}

export interface Machines {
  env: GitEnv
  /** The bare repository both machines push to. */
  remote: string
  /** Repository roots of the two clones. */
  a: string
  b: string
  /** The project folder in each clone: the root, or `sub` inside it. */
  projectA: string
  projectB: string
  git: (cwd: string, ...args: string[]) => string
}

/** A bare remote and two clones (machines A and B) sharing a first commit of `files` (inside the project) and `outside`. */
export async function twoMachines(
  files: Record<string, string> = { 'project.yaml': 'schema_version: 1\nname: Thesis\n' },
  opts: { sub?: string; outside?: Record<string, string> } = {}
): Promise<Machines> {
  const env = await isolatedGitEnv()
  const git = (cwd: string, ...args: string[]): string => runGit(env, cwd, ...args)
  const root = await tmpDir()
  const remote = join(root, 'remote.git')
  const a = join(root, 'a')
  const b = join(root, 'b')
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', remote)
  git(root, 'clone', '--quiet', remote, a)
  git(a, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  identify(env, a, 'Machine A')
  const sub = opts.sub ?? ''
  await applyFiles(join(a, sub), files)
  await applyFiles(a, opts.outside ?? {})
  git(a, 'add', '--all')
  git(a, 'commit', '--quiet', '-m', 'init')
  git(a, 'push', '--quiet', '--set-upstream', 'origin', 'main')
  git(root, 'clone', '--quiet', remote, b)
  identify(env, b, 'Machine B')
  return { env, remote, a, b, projectA: join(a, sub), projectB: join(b, sub), git }
}

/** Commits everything in a clone by hand, as the user would with git. */
export function commitAll(m: Machines, repo: string, message: string): void {
  m.git(repo, 'add', '--all')
  m.git(repo, 'commit', '--quiet', '-m', message)
}

/** A folder holding only git (no git-lfs), to put alone on PATH. Linux only. */
export async function pathWithOnlyGit(): Promise<string> {
  const dir = await tmpDir()
  const git = realpathSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim())
  await symlink(git, join(dir, 'git'))
  return dir
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Points machine A's remote at an ssh "server" that never answers: a script that records its pid and sleeps, so a
 * fetch hangs until it is cut short. No network is involved. Linux only (`sh`). The sleep is far longer than any test waits
 * but short enough that a failed run leaves nothing for long; call `kill()` in a `finally` so it leaves nothing at all.
 */
export async function hangingRemote(m: Machines): Promise<{ env: GitEnv; pids: () => Promise<number[]>; kill: () => Promise<void> }> {
  const dir = await tmpDir()
  const pidFile = join(dir, 'pids')
  const script = join(dir, 'fake-ssh')
  await writeFile(script, `#!/bin/sh\necho $$ >> '${pidFile}'\nexec sleep 60\n`)
  await chmod(script, 0o755)
  m.git(m.a, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid/remote.git')
  const pids = async (): Promise<number[]> => {
    try {
      return (await readFile(pidFile, 'utf8')).split('\n').filter(Boolean).map(Number)
    } catch {
      return []
    }
  }
  const kill = async (): Promise<void> => {
    for (const pid of await pids()) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone, as it should be.
      }
    }
  }
  return { env: { ...m.env, GIT_SSH_COMMAND: script }, pids, kill }
}
