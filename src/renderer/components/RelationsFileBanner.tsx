import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RelationsFileState } from '../../shared/typedRelations'
import { useEvent } from '../hooks/useEvent'
import { errorText } from '../lib/errorText'

/**
 * Mounted once for the open project: shown while relations.yaml has git conflict markers (the app does not write it)
 * or cannot be read, and after an automatic resolution that had to leave invalid entries out.
 */
export function RelationsFileBanner(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [state, setState] = useState<RelationsFileState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dropped, setDropped] = useState(0)
  const request = useRef(0)

  const refresh = useCallback(() => {
    const token = ++request.current
    window.research.relations.fileState().then(
      (next) => {
        if (token === request.current) setState(next)
      },
      () => {
        if (token === request.current) setError(errorText(t, 'unknown'))
      }
    )
  }, [t])
  useEffect(refresh, [refresh])
  useEvent('library-changed', refresh)

  const resolve = (): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    window.research.relations.resolveConflict().then(
      (r) => {
        setBusy(false)
        if (r.ok) setDropped(r.dropped)
        else setError(errorText(t, r.error))
        refresh()
      },
      () => {
        setBusy(false)
        setError(errorText(t, 'unknown'))
      }
    )
  }

  const show = (): void => {
    window.research.relations.showFile().catch(() => setError(errorText(t, 'unknown')))
  }

  const problem = state?.status === 'conflict' || state?.status === 'invalid' ? state : null
  if (!problem) {
    if (dropped === 0 && !error) return null
    return (
      <div className={`banner relations-file-banner${error ? ' error' : ' warning'}`} role="status">
        <span>{error ?? t('typed.file.resolved_dropped', { count: dropped })}</span>
        <button
          className="small"
          onClick={() => {
            setDropped(0)
            setError(null)
          }}
        >
          {t('typed.file.dismiss')}
        </button>
      </div>
    )
  }
  return (
    <div className="banner warning relations-file-banner" role="alert">
      <span>{problem.status === 'conflict' ? t('typed.file.conflict') : t('typed.file.invalid', { message: problem.message })}</span>
      {problem.status === 'conflict' && (
        <button className="small" disabled={busy} onClick={resolve}>
          {t('typed.file.resolve')}
        </button>
      )}
      <button className="small" onClick={show}>
        {t('typed.file.show')}
      </button>
      {error && <span className="field-error">{error}</span>}
    </div>
  )
}
