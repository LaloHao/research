const PAPER_FOLDER = /^(?:papers|\.trash)\/([a-z][a-z0-9]*)\//
const LISTED = 20

/** Names this machine in commit messages: one line, at most 60 characters. */
export function machineName(raw: string): string {
  const name = raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60)
  return name || 'unknown machine'
}

/** Paper keys whose folder (in the library or the trash) the paths touch; paths are from the repository root. */
export function touchedPapers(paths: string[], prefix: string): string[] {
  const keys = new Set<string>()
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue
    const key = PAPER_FOLDER.exec(path.slice(prefix.length))?.[1]
    if (key) keys.add(key)
  }
  return [...keys].sort()
}

/** `research: sync from <machine>`, with the touched papers in the body. */
export function syncCommitMessage(machine: string, paths: string[], prefix: string): string {
  const subject = `research: sync from ${machineName(machine)}`
  const keys = touchedPapers(paths, prefix)
  if (keys.length === 0) return `${subject}\n`
  const more = keys.length > LISTED ? ` (and ${keys.length - LISTED} more)` : ''
  return `${subject}\n\nPapers: ${keys.slice(0, LISTED).join(', ')}${more}\n`
}

export function mergeCommitMessage(machine: string): string {
  return `research: merge sync from ${machineName(machine)}\n`
}
