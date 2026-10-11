/** The trash lives inside the project, so git carries removals and restores between machines. */
export const TRASH_DIR = '.trash'
/** Written into `.trash/<key>/` when a paper is removed; deleted again when it is restored. */
export const TRASHED_FILE = 'trashed.yaml'

/** Where a copy that must not be lost goes beside another: `summary.md` → `summary.trashed.md`, then `summary.trashed-2.md`. */
export function siblingName(name: string, tag: string, n = 1): string {
  const dot = name.lastIndexOf('.')
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  return `${base}.${tag}${n > 1 ? `-${n}` : ''}${ext}`
}
