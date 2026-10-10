import { useCallback, useEffect, useRef } from 'react'

/** Calls the latest `callback` once, `ms` after the last call: a burst of events (one per job) becomes one refresh. */
export function useDebouncedCallback(callback: () => void, ms: number): () => void {
  const latest = useRef(callback)
  latest.current = callback
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => latest.current(), ms)
  }, [ms])
}
