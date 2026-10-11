import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { moveDir, type MoveOps } from '../../../src/main/project/atomicWrite'
import { tmpDir } from '../../helpers/tmp'

async function folder(): Promise<{ root: string; from: string; to: string }> {
  const root = await tmpDir()
  const from = join(root, 'papers', 'x1')
  await mkdir(join(from, 'sub'), { recursive: true })
  await writeFile(join(from, 'paper.yaml'), 'a')
  await writeFile(join(from, 'sub', 'f.txt'), 'b')
  return { root, from, to: join(root, '.trash', 'x1') }
}
const fail = (code: string): Error => Object.assign(new Error(code), { code })
const real: MoveOps = { rename, cp, rm }

describe('moveDir', () => {
  it('moves a folder with one rename, creating the destination parent', async () => {
    const { from, to } = await folder()
    await moveDir(from, to)
    expect(existsSync(from)).toBe(false)
    expect(await readFile(join(to, 'sub', 'f.txt'), 'utf8')).toBe('b')
  })

  it('copies under a hidden name, renames it into place and removes the source when the rename crosses disks', async () => {
    const { root, from, to } = await folder()
    const ops: MoveOps = { ...real, rename: async (a, b) => (a === from ? Promise.reject(fail('EXDEV')) : rename(a, b)) }
    await moveDir(from, to, ops)
    expect(existsSync(from)).toBe(false)
    expect(await readFile(join(to, 'paper.yaml'), 'utf8')).toBe('a')
    expect(await readFile(join(to, 'sub', 'f.txt'), 'utf8')).toBe('b')
    expect(await readdir(join(root, '.trash'))).toEqual(['x1'])
  })

  it('counts the move as done when only removing the copied source fails', async () => {
    const { from, to } = await folder()
    const ops: MoveOps = {
      ...real,
      rename: async (a, b) => (a === from ? Promise.reject(fail('EXDEV')) : rename(a, b)),
      rm: async (p, o) => (p === from ? Promise.reject(fail('EBUSY')) : rm(p, o))
    }
    await moveDir(from, to, ops)
    expect(await readFile(join(to, 'paper.yaml'), 'utf8')).toBe('a')
  })

  it('retries a rename refused for a moment (Windows: a file briefly open), then gives up with its code', async () => {
    const { from, to } = await folder()
    let tries = 0
    const flaky: MoveOps = { ...real, rename: async (a, b) => (++tries < 3 ? Promise.reject(fail('EPERM')) : rename(a, b)) }
    await moveDir(from, to, flaky, 1)
    expect(tries).toBe(3)
    expect(existsSync(to)).toBe(true)
    const stuck: MoveOps = { ...real, rename: async () => Promise.reject(fail('EBUSY')) }
    await expect(moveDir(to, from, stuck, 1)).rejects.toMatchObject({ code: 'EBUSY' })
  })

  it('leaves the source untouched and no temp folder behind when the copy fails', async () => {
    const { root, from, to } = await folder()
    const ops: MoveOps = { ...real, rename: async () => Promise.reject(fail('EXDEV')), cp: async () => Promise.reject(fail('ENOSPC')) }
    await expect(moveDir(from, to, ops)).rejects.toThrow('ENOSPC')
    expect(await readFile(join(from, 'paper.yaml'), 'utf8')).toBe('a')
    expect(await readdir(join(root, '.trash'))).toEqual([])
  })
})
