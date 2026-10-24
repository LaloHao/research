import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCapped, readWithIncludes } from '../../../src/main/writing/includes'
import { tmpDir } from '../../helpers/tmp'

async function tree(files: Record<string, string>): Promise<string> {
  const root = await tmpDir()
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}

describe('readWithIncludes', () => {
  it('follows \\input, \\include and \\subfile, keeping keys in order of appearance', async () => {
    const root = await tree({
      'thesis/main.tex': 'Intro \\cite{a}.\n\\input{ch1}\n\\include{parts/ch2.tex}\nEnd \\cite{d,a}.\n% \\input{commented}',
      'thesis/ch1.tex': 'One \\citep{b}.',
      'thesis/parts/ch2.tex': 'Two \\cite{c}. \\subfile{parts/deep}',
      'thesis/parts/deep.tex': 'Deep \\cite{e}.'
    })
    const read = await readWithIncludes(join(root, 'thesis/main.tex'))
    expect(read.keys).toEqual(['a', 'b', 'c', 'e', 'd'])
    expect(read.files.map((f) => f.path)).toEqual(['main.tex', 'ch1.tex', 'parts/ch2.tex', 'parts/deep.tex'])
    expect(read.citations).toBe(5)
    expect(read.skipped).toEqual([])
  })

  it('follows Org #+INCLUDE relative to the including file', async () => {
    const root = await tree({
      'thesis.org': '#+TITLE: T\n* Intro\nText [cite:@a].\n#+INCLUDE: "chapters/one.org" :minlevel 2',
      'chapters/one.org': 'More [cite:@b;@c].\n#+INCLUDE: "two.org"',
      'chapters/two.org': '[cite/t:@d]'
    })
    const read = await readWithIncludes(join(root, 'thesis.org'))
    expect(read.keys).toEqual(['a', 'b', 'c', 'd'])
    expect(read.files.map((f) => [f.path, f.format])).toEqual([
      ['thesis.org', 'org'],
      ['chapters/one.org', 'org'],
      ['chapters/two.org', 'org']
    ])
  })

  it('never reads outside the chosen file’s folder, by path or by symbolic link', async () => {
    const root = await tree({ 'outside.tex': '\\cite{secret}', 'thesis/main.tex': '\\input{../outside}\n\\input{/etc/hostname}\n\\input{link}\n\\input{dirlink/outside}' })
    await symlink(join(root, 'outside.tex'), join(root, 'thesis/link.tex'))
    await symlink(root, join(root, 'thesis/dirlink'))
    const read = await readWithIncludes(join(root, 'thesis/main.tex'))
    expect(read.keys).toEqual([])
    expect(read.skipped.map((s) => [s.path, s.reason])).toEqual([
      ['../outside', 'outside_folder'],
      ['/etc/hostname', 'outside_folder'],
      ['link', 'outside_folder'],
      ['dirlink/outside', 'outside_folder']
    ])
  })

  it('follows a symbolic link that stays inside the folder', async () => {
    const root = await tree({ 'thesis/main.tex': '\\input{alias}', 'thesis/real.tex': '\\cite{a}' })
    await symlink(join(root, 'thesis/real.tex'), join(root, 'thesis/alias.tex'))
    expect((await readWithIncludes(join(root, 'thesis/main.tex'))).keys).toEqual(['a'])
  })

  it('reports cycles, missing files and too deep includes', async () => {
    const root = await tree({
      'main.tex': '\\input{a}\\input{missing}',
      'a.tex': '\\cite{x}\\input{b}',
      'b.tex': '\\input{a}\\input{main}'
    })
    const read = await readWithIncludes(join(root, 'main.tex'))
    expect(read.keys).toEqual(['x'])
    expect(read.skipped.map((s) => [s.from, s.path, s.reason])).toEqual([
      ['b.tex', 'a', 'cycle'],
      ['b.tex', 'main', 'cycle'],
      ['main.tex', 'missing', 'missing']
    ])
    const chain: Record<string, string> = {}
    for (let i = 0; i < 12; i++) chain[`f${i}.tex`] = `\\cite{k${i}}\\input{f${i + 1}}`
    const deep = await tree(chain)
    const limited = await readWithIncludes(join(deep, 'f0.tex'))
    expect(limited.files).toHaveLength(9)
    expect(limited.skipped).toEqual([{ from: 'f8.tex', path: 'f9', reason: 'too_deep' }])
  })

  it('skips an included file over the size limit and refuses a chosen file over it', async () => {
    const root = await tree({ 'main.tex': '\\input{big}', 'big.tex': 'x'.repeat(200) })
    const read = await readWithIncludes(join(root, 'main.tex'), { maxDepth: 8, maxFiles: 10, maxFileBytes: 100, maxTotalBytes: 1000 })
    expect(read.skipped).toEqual([{ from: 'main.tex', path: 'big', reason: 'too_large' }])
    await expect(readWithIncludes(join(root, 'big.tex'), { maxDepth: 8, maxFiles: 10, maxFileBytes: 100, maxTotalBytes: 1000 })).rejects.toThrow('writing_file_too_large')
    await expect(readWithIncludes(join(root, 'nope.tex'))).rejects.toThrow('writing_file_unreadable')
  })

  it('bounds what it reads, not what a stat said: the cap applies to the bytes read and to the total', async () => {
    const root = await tree({ 'exact.tex': 'x'.repeat(100), 'over.tex': 'x'.repeat(101), 'main.tex': '\\input{a}\\input{b}', 'a.tex': 'y'.repeat(60), 'b.tex': 'z'.repeat(60) })
    expect((await readCapped(join(root, 'exact.tex'), 100))?.length).toBe(100)
    expect(await readCapped(join(root, 'over.tex'), 100)).toBeNull()
    // The second include would pass the total (16 + 60 + 60 > 130).
    const read = await readWithIncludes(join(root, 'main.tex'), { maxDepth: 8, maxFiles: 10, maxFileBytes: 100, maxTotalBytes: 130 })
    expect(read.files.map((f) => f.path)).toEqual(['main.tex', 'a.tex'])
    expect(read.skipped).toEqual([{ from: 'main.tex', path: 'b', reason: 'too_large' }])
  })
})
