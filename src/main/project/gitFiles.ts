import type { PdfPolicy } from '../../shared/schemas'

const BEGIN = '# >>> research-app managed >>>'
const END = '# <<< research-app managed <<<'
const BLOCK = /# >>> research-app managed >>>[\s\S]*?# <<< research-app managed <<<\n?/

/** Replaces (or appends) the app's block, leaving every user-written line alone. */
export function withManagedBlock(existing: string, lines: string[]): string {
  const block = `${[BEGIN, ...lines, END].join('\n')}\n`
  if (BLOCK.test(existing)) return existing.replace(BLOCK, () => block)
  if (existing.length === 0) return block
  const sep = existing.endsWith('\n') ? '\n' : '\n\n'
  return `${existing}${sep}${block}`
}

/** PDFs in the library, in the trash, and copies kept beside them on a merge (paper.trashed.pdf…) follow one policy. */
const PDF_PATTERNS = ['papers/*/paper.pdf', 'papers/*/paper.*.pdf', '.trash/*/paper.pdf', '.trash/*/paper.*.pdf']

/** `.cache/` is never committed; the dot-temp names `atomicWrite` and `moveDir` leave behind on a crash never are either. */
const ALWAYS_IGNORED = ['.cache/', '.*.tmp', '.*.moving']

export function gitignoreLines(policy: PdfPolicy): string[] {
  return policy === 'untracked' ? [...ALWAYS_IGNORED, ...PDF_PATTERNS] : ALWAYS_IGNORED
}

export function gitattributesLines(policy: PdfPolicy): string[] {
  return policy === 'lfs' ? PDF_PATTERNS.map((p) => `${p} filter=lfs diff=lfs merge=lfs -text`) : []
}
