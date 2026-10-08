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

export function gitignoreLines(policy: PdfPolicy): string[] {
  return policy === 'untracked' ? ['.cache/', 'papers/*/paper.pdf'] : ['.cache/']
}

export function gitattributesLines(policy: PdfPolicy): string[] {
  return policy === 'lfs' ? ['papers/*/paper.pdf filter=lfs diff=lfs merge=lfs -text'] : []
}
