/**
 * «Cambiar clave»: the project files outside a paper's folder that name it by its key (relations.yaml aside, which
 * LibraryService rekeys itself first), each rewritten by its own service through hash-checked writes.
 */
export interface PaperReferences {
  /** Rewrites every reference to `from` as `to`. On a failure it puts back what it changed and throws; otherwise it resolves with the undo of all of it. */
  rekey(from: string, to: string): Promise<() => Promise<void>>
}

/** One kind of file: rewrites it and returns how to put it back (null when nothing named `from`). */
export interface ReferenceStep {
  name: string
  rekey(from: string, to: string): Promise<(() => Promise<unknown>) | null>
}

/** The steps run in order; a failure undoes the ones that ran, newest first (an undo that fails is logged, never thrown). */
export function paperReferences(steps: ReferenceStep[]): PaperReferences {
  return {
    async rekey(from, to) {
      const undos: { name: string; undo: () => Promise<unknown> }[] = []
      const undoAll = async (): Promise<void> => {
        for (const { name, undo } of [...undos].reverse()) await undo().catch((error: unknown) => console.error('change key: undo', name, from, error))
      }
      try {
        for (const step of steps) {
          const undo = await step.rekey(from, to)
          if (undo) undos.push({ name: step.name, undo })
        }
      } catch (error) {
        await undoAll()
        throw error
      }
      return undoAll
    }
  }
}
