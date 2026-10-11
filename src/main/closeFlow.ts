import type { CloseDecision } from '../shared/sync'

export interface CloseSteps {
  /**
   * Lets the renderer save pending edits (notes in their autosave delay). The acknowledgement also
   * doubles as proof the renderer is alive: `false` (timeout, send failure, or no listener) means
   * closing goes ahead without asking, since there is nothing left to show the prompt in.
   */
  flush(): Promise<boolean>
  /** Changes not committed or not pushed in a project that syncs with a remote. */
  unsynced(): Promise<boolean>
  /** «Hay cambios sin sincronizar»: the renderer syncs on its own for «Sincronizar y cerrar» and answers `close` once done. */
  ask(): Promise<CloseDecision>
}

/**
 * Whether the window may close: after saving pending edits, ask only when the renderer is alive
 * (it acknowledged the flush) and something is not synced.
 */
export async function confirmClose(steps: CloseSteps): Promise<boolean> {
  const flushed = await steps.flush()
  if (!flushed) return true
  const unsynced = await steps.unsynced().catch((error: unknown) => {
    console.error('sync status on close', error)
    return false
  })
  if (!unsynced) return true
  return (await steps.ask()) === 'close'
}

/** Runs `run` at most once concurrently: a call that arrives while one is in flight joins it instead of starting another. */
export function once<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null
  return () => {
    inFlight ??= run().finally(() => {
      inFlight = null
    })
    return inFlight
  }
}

export type QuitAction = 'allow' | 'join' | 'start'

/**
 * What a `before-quit` arrival (or the `app.quit()` from `window-all-closed`) should do, given whether
 * a shutdown is already running or already finished:
 * - `'allow'`: a shutdown already finished; let this quit go through with no `preventDefault`.
 * - `'join'`: another arrival is already driving the shutdown; `preventDefault` and do nothing else —
 *   that chain will call `quit()` once it is done.
 * - `'start'`: nothing is running yet; `preventDefault` and drive `confirmLeave` + `shutdown` here.
 *
 * Only the arrival that gets `'start'` is ever allowed to call `quit()` afterwards, and only once the
 * shutdown it started has actually finished — never a `before-quit` that merely joined it. This keeps
 * two quit requests racing during the prompt, or a window close followed by a quit, from exiting the
 * app while `shutdown()` is still in progress.
 */
export function decideQuit(state: { quitting: boolean; shutDown: boolean }): QuitAction {
  if (state.shutDown) return 'allow'
  if (state.quitting) return 'join'
  return 'start'
}
