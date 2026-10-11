/**
 * Asks the renderer to save pending edits and resolves `true` as soon as it acknowledges, or `false`
 * after `timeoutMs` (or if `send` throws) so a hung or crashed renderer never blocks closing. The
 * acknowledgement also doubles as a liveness check: a renderer that never answers is treated as gone.
 */
export function waitForFlush(send: () => void, onAck: (ack: () => void) => () => void, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let off = (): void => {}
    const done = (acked: boolean): void => {
      clearTimeout(timer)
      off()
      resolve(acked)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    off = onAck(() => done(true))
    try {
      send()
    } catch {
      done(false)
    }
  })
}
