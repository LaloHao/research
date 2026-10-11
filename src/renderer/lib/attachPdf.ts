/** What to do once the user picked or dropped a file for a paper. */
export type AttachStep = { kind: 'idle' } | { kind: 'confirm'; path: string } | { kind: 'send'; path: string; replace: boolean }

/** The dropped file when the drop is exactly one `.pdf`; null otherwise (nothing to attach). */
export function droppedPdf<F extends { name: string }>(files: readonly F[]): F | null {
  if (files.length !== 1) return null
  return /.\.pdf$/i.test(files[0].name) ? files[0] : null
}

/** Whether a drag carries files (its names are only readable on drop). */
export function isFileDrag(types: readonly string[]): boolean {
  return types.includes('Files')
}

/** A paper without a PDF gets it right away; replacing an existing one asks first. */
export function afterPick(path: string | null, hasPdf: boolean): AttachStep {
  if (!path) return { kind: 'idle' }
  return hasPdf ? { kind: 'confirm', path } : { kind: 'send', path, replace: false }
}
