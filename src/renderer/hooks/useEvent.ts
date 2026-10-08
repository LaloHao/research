import { useEffect, useRef } from 'react'
import type { ResearchEvent } from '../../shared/ipc'

/** Subscribes to a main-process event; always calls the latest callback. */
export function useEvent(event: ResearchEvent, callback: () => void): void {
  const ref = useRef(callback)
  ref.current = callback
  useEffect(() => window.research.on(event, () => ref.current()), [event])
}
