import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { UserFacingError } from '../library/UserFacingError'
import type { SkipReason } from '../../shared/writing/api'
import { detectFormat, findIncludes, parseCitations, type CiteFormat } from '../../shared/writing/citations'

/** How far «BibTeX» follows `\input`/`\include`/`\subfile`/`#+INCLUDE`, and how much it reads. */
export const INCLUDE_LIMITS = { maxDepth: 8, maxFiles: 200, maxFileBytes: 2_000_000, maxTotalBytes: 20_000_000 }


export interface SourceRead {
  /** The chosen file's folder, real path: nothing outside it is read. */
  root: string
  /** Every file read, relative to `root` (`/`-separated), in the order they were reached. */
  files: { path: string; format: CiteFormat; citations: number }[]
  /** Keys cited, each once, in order of first appearance across the files (an include's keys where it is included). */
  keys: string[]
  citations: number
  /** Includes not followed, with where they were named. */
  skipped: { from: string; path: string; reason: SkipReason }[]
}

export function formatOfPath(path: string, text: string): CiteFormat {
  const ext = extname(path).toLowerCase()
  if (ext === '.tex' || ext === '.ltx' || ext === '.sty') return 'latex'
  if (ext === '.org') return 'org'
  if (ext === '.md' || ext === '.markdown' || ext === '.qmd' || ext === '.rmd') return 'markdown'
  return detectFormat(text)
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

const shown = (root: string, path: string): string => relative(root, path).split(sep).join('/')

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false
  )
}

/**
 * Reads the chosen file and, recursively, the files it includes: LaTeX `\input`, `\include`, `\subfile` (relative to
 * the chosen file's folder, then to the including file's, `.tex` added when missing) and Org `#+INCLUDE` (relative to
 * the including file). Never outside the chosen file's folder: paths are resolved to real paths, so `..` and symbolic
 * links that leave it are refused. Bounded depth and size; a file already being read (a cycle) is not read again.
 */
export async function readWithIncludes(file: string, limits = INCLUDE_LIMITS): Promise<SourceRead> {
  const main = await realpath(file).catch((error: unknown) => {
    throw new UserFacingError('writing_file_unreadable', { cause: error })
  })
  const root = dirname(main)
  const out: SourceRead = { root, files: [], keys: [], citations: 0, skipped: [] }
  const keys = new Set<string>()
  const seen = new Set<string>()
  let total = 0

  const visit = async (path: string, depth: number, stack: string[]): Promise<void> => {
    const size = (await stat(path)).size
    if (size > limits.maxFileBytes || total + size > limits.maxTotalBytes) throw new SkipError('too_large')
    total += size
    seen.add(path)
    const text = await readFile(path, 'utf8')
    const format = formatOfPath(path, text)
    const citations = parseCitations(text, format)
    const record = { path: shown(root, path), format, citations: citations.length }
    out.files.push(record)
    out.citations += citations.length
    const events = [...citations.map((c) => ({ at: c.start, keys: c.keys })), ...findIncludes(text, format).map((i) => ({ at: i.start, include: i }))].sort(
      (a, b) => a.at - b.at
    )
    for (const e of events) {
      if ('keys' in e) {
        for (const k of e.keys) {
          if (!keys.has(k)) {
            keys.add(k)
            out.keys.push(k)
          }
        }
        continue
      }
      const target = e.include.path
      const skip = (reason: SkipReason): void => void out.skipped.push({ from: record.path, path: target, reason })
      if (depth + 1 > limits.maxDepth) {
        skip('too_deep')
        continue
      }
      const resolved = await locate(target, e.include.command, path, root)
      if (resolved === null) {
        skip('missing')
        continue
      }
      if (!inside(root, resolved)) {
        skip('outside_folder')
        continue
      }
      // The real path, so a symbolic link (of the file or of a folder on the way) leaving the folder is refused.
      const real = await realpath(resolved).catch(() => null)
      if (real === null) {
        skip('missing')
        continue
      }
      if (!inside(root, real)) {
        skip('outside_folder')
        continue
      }
      if (stack.includes(real)) {
        skip('cycle')
        continue
      }
      // Included twice (not a cycle): its citations are already counted.
      if (seen.has(real)) continue
      if (out.files.length >= limits.maxFiles) {
        skip('too_many')
        continue
      }
      try {
        await visit(real, depth + 1, [...stack, real])
      } catch (error) {
        // An included file that cannot be read is reported, never fatal.
        skip(error instanceof SkipError ? error.reason : 'missing')
      }
    }
  }

  try {
    await visit(main, 0, [main])
  } catch (error) {
    if (error instanceof SkipError) throw new UserFacingError('writing_file_too_large', { cause: error })
    throw new UserFacingError('writing_file_unreadable', { cause: error })
  }
  return out
}

class SkipError extends Error {
  constructor(readonly reason: SkipReason) {
    super(reason)
  }
}

/** Where an include points: an existing regular file (or null). The path is not yet checked against the folder. */
async function locate(target: string, command: string, from: string, root: string): Promise<string | null> {
  const bases = command === 'org_include' ? [dirname(from)] : [root, dirname(from)]
  const names = command !== 'org_include' && extname(target) === '' ? [`${target}.tex`, target] : [target]
  for (const base of bases) {
    for (const name of names) {
      const candidate = resolve(base, name)
      // A symbolic link is followed by `stat`; whether its target stays inside the folder is checked by the caller.
      if ((await lstat(candidate).catch(() => null)) && (await isFile(candidate))) return candidate
    }
  }
  return null
}
