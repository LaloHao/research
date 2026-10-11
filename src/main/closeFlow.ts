import type { CloseDecision } from '../shared/sync'

export interface CloseSteps {
  /** Lets the renderer save pending edits (notes in their autosave delay). */
  flush(): Promise<void>
  /** Changes not committed or not pushed in a project that syncs with a remote. */
  unsynced(): Promise<boolean>
  /** «Hay cambios sin sincronizar»: the renderer syncs on its own for «Sincronizar y cerrar» and answers `close` once done. */
  ask(): Promise<CloseDecision>
}

/** Whether the window may close: after saving pending edits, ask only when something is not synced. */
export async function confirmClose(steps: CloseSteps): Promise<boolean> {
  await steps.flush()
  const unsynced = await steps.unsynced().catch((error: unknown) => {
    console.error('sync status on close', error)
    return false
  })
  if (!unsynced) return true
  return (await steps.ask()) === 'close'
}
