type FlushHandler = () => Promise<void>

const handlers = new Set<FlushHandler>()

/** Registers something with unsaved work (e.g. a notes editor) to save when the window is about to close. */
export function onFlush(handler: FlushHandler): () => void {
  handlers.add(handler)
  return () => void handlers.delete(handler)
}

/** Saves everything pending; a failing handler does not stop the others. */
export async function flushAll(): Promise<void> {
  await Promise.allSettled([...handlers].map((handler) => handler()))
}
