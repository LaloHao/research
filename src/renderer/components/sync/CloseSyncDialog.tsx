import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CloseDecision } from '../../../shared/sync'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { pathList } from '../../lib/sync'

type Stage = { kind: 'hidden' } | { kind: 'asking' } | { kind: 'syncing' } | { kind: 'failed'; text: string }

/**
 * «Hay cambios sin sincronizar» when the window closes: «Sincronizar y cerrar» (the window closes only after a
 * successful sync; conflicts or an error keep it open and say why), «Cerrar sin sincronizar» or «Cancelar».
 * Mounted outside the project shell so the main process, which waits for the answer, always gets one.
 */
export function CloseSyncDialog({ onOpenSync }: { onOpenSync: () => void }): React.JSX.Element | null {
  const { t } = useTranslation()
  const [stage, setStage] = useState<Stage>({ kind: 'hidden' })
  const syncing = useRef(false)
  const request = useRef(0)

  useEvent('close-request', () => {
    // A sync started from this prompt answers it when it ends.
    if (syncing.current) return
    request.current++
    setStage({ kind: 'asking' })
  })

  const answer = (decision: CloseDecision): void => {
    request.current++
    setStage({ kind: 'hidden' })
    window.research.closeDecision(decision)
  }

  const syncAndClose = (): void => {
    if (syncing.current) return
    syncing.current = true
    const token = ++request.current
    setStage({ kind: 'syncing' })
    const done = (next: Stage | 'close'): void => {
      syncing.current = false
      if (token !== request.current) return
      if (next === 'close') answer('close')
      else setStage(next)
    }
    window.research.sync.run().then(
      (result) => {
        if (result.ok && result.outcome === 'synced') return done('close')
        if (result.ok) {
          // The conflicts panel is in the Sync view: show it behind the prompt.
          onOpenSync()
          return done({ kind: 'failed', text: t('sync.close.conflicts') })
        }
        done({ kind: 'failed', text: t(`sync.errors.${result.error.code}`, { paths: pathList(result.error.paths) }) })
      },
      () => done({ kind: 'failed', text: errorText(t, 'unknown') })
    )
  }

  if (stage.kind === 'hidden') return null
  const busy = stage.kind === 'syncing'
  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="close-sync-title"
        aria-describedby="close-sync-text"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) answer('cancel')
        }}
      >
        <h3 id="close-sync-title">{t('sync.close.title')}</h3>
        <p id="close-sync-text" className={stage.kind === 'failed' ? 'error' : undefined} aria-live="polite">
          {stage.kind === 'failed' ? stage.text : busy ? t('sync.close.syncing') : t('sync.close.body')}
        </p>
        <div className="row">
          {stage.kind !== 'failed' && (
            <button className="primary" autoFocus disabled={busy} onClick={syncAndClose}>
              {t('sync.close.sync_and_close')}
            </button>
          )}
          {stage.kind === 'failed' && (
            <button
              className="primary"
              autoFocus
              onClick={() => {
                answer('cancel')
                onOpenSync()
              }}
            >
              {t('sync.close.open_sync')}
            </button>
          )}
          <button disabled={busy} onClick={() => answer('close')}>
            {t('sync.close.close_anyway')}
          </button>
          <button disabled={busy} onClick={() => answer('cancel')}>
            {t('sync.close.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
