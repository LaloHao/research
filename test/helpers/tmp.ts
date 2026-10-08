import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const created: string[] = []

export async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'research-test-'))
  created.push(dir)
  return dir
}

/** Removes every directory made by `tmpDir()` in this test file (run from test/setup.ts). */
export async function cleanupTmpDirs(): Promise<void> {
  const dirs = created.splice(0)
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)))
}
