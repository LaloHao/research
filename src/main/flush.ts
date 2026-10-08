/**
 * Asks the renderer to save pending edits and resolves when it acknowledges, or after `timeoutMs`
 * so a hung or crashed renderer never blocks closing.
 */
export function waitForFlush(send: () => void, onAck: (ack: () => void) => () => void, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    let off = (): void => {}
    const done = (): void => {
      clearTimeout(timer)
      off()
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    off = onAck(done)
    try {
      send()
    } catch {
      done()
    }
  })
}
