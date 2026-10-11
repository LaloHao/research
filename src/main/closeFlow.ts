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

export interface QuitDeps {
  /** Flushes, and asks «Hay cambios sin sincronizar» when needed, for the single window; whether leaving is allowed. */
  confirmLeave(): Promise<boolean>
  /** Closes everything down for good (sessions, the write gate, embeddings, …). */
  shutdown(): Promise<void>
  /** Requests the native quit, e.g. `app.quit()`. */
  quit(): void
}

export interface QuitFlow {
  /**
   * Call for every `before-quit` arrival — including the one `window-all-closed`'s `app.quit()`
   * triggers. Returns whether the caller must call `event.preventDefault()`: every arrival does,
   * except the one that finds the shutdown this flow started already finished.
   *
   * Only the arrival that starts the chain (the first one, or the first one after a previous chain
   * was cancelled) ever drives `confirmLeave()` and `shutdown()`; every other arrival while it runs
   * only prevents the default and waits — that chain is the only one that ever calls `quit()`, and
   * only once `shutdown()` has settled (it still quits even if `shutdown()` throws).
   */
  beforeQuit(): boolean
  /**
   * True once the running (or last) quit chain's `confirmLeave()` resolved `true` — the user (or the
   * renderer being gone) actually allowed leaving, not merely that a quit was requested. The window's
   * own `close` handler uses this instead of "a quit is pending" so that clicking ✕ while «Hay cambios
   * sin sincronizar» is still open joins that same prompt instead of skipping it.
   */
  isLeavingConfirmed(): boolean
}

/** The quit state machine shared by the window's `close` handler and `before-quit`/`window-all-closed`. */
export function createQuitFlow(deps: QuitDeps): QuitFlow {
  let quitting = false // a chain is confirming or shutting down
  let shutDown = false // that chain's shutdown finished: a later arrival may go straight through
  let leavingConfirmed = false // that chain's confirmLeave() resolved true

  async function run(): Promise<void> {
    const ok = await deps.confirmLeave().catch((error: unknown) => {
      console.error('leave', error)
      return false
    })
    if (!ok) {
      quitting = false
      return
    }
    leavingConfirmed = true
    try {
      await deps.shutdown()
    } catch (error) {
      console.error('shutdown', error)
    }
    // The app must always be able to quit, even when shutdown() failed to finish cleanly.
    shutDown = true
    deps.quit()
  }

  function beforeQuit(): boolean {
    if (shutDown) return false
    if (quitting) return true
    quitting = true
    void run()
    return true
  }

  return { beforeQuit, isLeavingConfirmed: () => leavingConfirmed }
}
