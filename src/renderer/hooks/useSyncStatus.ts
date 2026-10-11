import { useCallback, useEffect, useRef, useState } from 'react'
import type { SyncStatus } from '../../shared/sync'
import { useDebouncedCallback } from './useDebouncedCallback'
import { useEvent } from './useEvent'

export interface SyncState {
  /** null until the first answer; 'failed' when the status could not be read. */
  status: SyncStatus | null | 'failed'
  /** When the status was last read, for «hace N min». */
  now: number
  refresh: () => void
}

/** The open project's sync status: on load, on every sync change, after library writes (debounced) and every 30 s. */
export function useSyncStatus(): SyncState {
  const [status, setStatus] = useState<SyncStatus | null | 'failed'>(null)
  const [now, setNow] = useState(() => Date.now())
  const request = useRef(0)

  const refresh = useCallback(() => {
    const token = ++request.current
    window.research.sync.status().then(
      (next) => {
        if (token !== request.current) return
        setStatus(next)
        setNow(Date.now())
      },
      () => {
        if (token === request.current) setStatus('failed')
      }
    )
  }, [])
  const soon = useDebouncedCallback(refresh, 1000)

  useEffect(refresh, [refresh])
  useEvent('sync-changed', refresh)
  useEvent('library-changed', soon)
  useEffect(() => {
    const timer = setInterval(refresh, 30_000)
    return () => clearInterval(timer)
  }, [refresh])

  return { status, now, refresh }
}
