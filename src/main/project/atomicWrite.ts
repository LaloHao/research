import { createHash, randomBytes } from 'node:crypto'
import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Writes through a dot-prefixed temp file in the same directory, then renames over the target. */
export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, data)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** File system calls of `moveDir`, injectable so tests can simulate other disks and Windows locks. */
export interface MoveOps {
  rename(from: string, to: string): Promise<void>
  cp(from: string, to: string, opts: { recursive: true; errorOnExist: true; force: false }): Promise<void>
  rm(path: string, opts: { recursive: true; force: true }): Promise<void>
}

const FS_OPS: MoveOps = { rename, cp, rm }
/** Windows refuses a rename for a moment while another process (an indexer, an antivirus, a viewer) has a file open. */
export const MOVE_RETRYABLE: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])
const MAX_RETRIES = 3

/**
 * Moves a folder. Within the project this is one rename, so a crash never leaves half a folder on each side; a refused
 * rename is retried with a growing wait (retryMs, ×2, ×4). Only when the destination is on another disk (EXDEV) the folder
 * is copied under a dot-prefixed temp name (ignored by the watcher), renamed into place, and then the source is removed;
 * a failed copy leaves the source untouched, and a source that cannot be removed afterwards is only logged.
 */
export async function moveDir(from: string, to: string, ops: MoveOps = FS_OPS, retryMs = 100): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  for (let attempt = 0; ; attempt++) {
    try {
      await ops.rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EXDEV') break
      if (code && MOVE_RETRYABLE.has(code) && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, retryMs * 2 ** attempt))
        continue
      }
      throw error
    }
  }
  const tmp = join(dirname(to), `.${basename(to)}.${randomBytes(6).toString('hex')}.moving`)
  try {
    await ops.cp(from, tmp, { recursive: true, errorOnExist: true, force: false })
    await ops.rename(tmp, to)
  } catch (error) {
    await ops.rm(tmp, { recursive: true, force: true })
    throw error
  }
  try {
    await ops.rm(from, { recursive: true, force: true })
  } catch (error) {
    console.error('moveDir: copied, but could not remove the source', from, error)
  }
}
