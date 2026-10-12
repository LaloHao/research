import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SyncError } from '../../../shared/sync'
import type { SyncState } from '../../hooks/useSyncStatus'
import { errorText } from '../../lib/errorText'
import { pathList, syncIndicator } from '../../lib/sync'
import { ConflictsPanel } from './ConflictsPanel'
import { SyncSetupPanel } from './SyncSetupPanel'

type Notice = { error: boolean; text: string }

/** «Sincronización»: the full status, the last error, «Sincronizar», the first use and the conflicts waiting. */
export function SyncView({ sync }: { sync: SyncState }): React.JSX.Element {
  const { t } = useTranslation()
  const { status, now, refresh } = sync
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const indicator = syncIndicator(status, now)
  const loaded = status !== null && status !== 'failed' ? status : null
  // The project folder is gone (an unplugged drive): the status says `no_repo`, but creating a repository would be wrong.
  const projectMissing = loaded?.error?.code === 'project_missing'
  const conflicts = loaded?.conflicts ?? 0
  const heading = useRef<HTMLHeadingElement>(null)
  const hadConflicts = useRef(conflicts > 0)

  // «Terminar» or «Cancelar» removes the conflicts panel with the focused button: bring the focus back to the view.
  useEffect(() => {
    if (hadConflicts.current && conflicts === 0 && document.activeElement === document.body) heading.current?.focus()
    hadConflicts.current = conflicts > 0
  }, [conflicts])

  const run = (): void => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    window.research.sync.run().then(
      (result) => {
        setBusy(false)
        // A failure is in the status (its banner below); conflicts open their panel.
        if (result.ok && result.outcome === 'synced') setNotice({ error: false, text: t('sync.done') })
        refresh()
      },
      () => {
        setBusy(false)
        setNotice({ error: true, text: errorText(t, 'unknown') })
        refresh()
      }
    )
  }

  return (
    <div className="sync">
      <header className="sync-header">
        <h2 ref={heading} tabIndex={-1}>
          {t('sync.title')}
        </h2>
        <p className={`sync-state tone-${indicator.tone}`} aria-live="polite">
          {t(`sync.status.${indicator.state}`, { count: indicator.count })}
        </p>
        {status === 'failed' && (
          <div className="row">
            <button onClick={refresh}>{t('sync.retry')}</button>
          </div>
        )}
        {loaded?.repoRoot && (
          <p className="muted small">
            {loaded.upstream
              ? t('sync.repo_upstream', { root: loaded.repoRoot, branch: loaded.branch ?? '—', upstream: loaded.upstream })
              : t('sync.repo', { root: loaded.repoRoot, branch: loaded.branch ?? '—' })}
          </p>
        )}
        {loaded?.setup === 'ready' && (
          <div className="row">
            <button className="primary" disabled={busy || loaded.phase === 'syncing' || loaded.conflicts > 0} onClick={run}>
              {t('sync.run')}
            </button>
          </div>
        )}
      </header>
      {loaded?.error && (loaded.phase === 'error' || projectMissing) && <SyncErrorNotice error={loaded.error} />}
      {/* «Sincronizado.» belongs to the last manual run: a later failure (e.g. an automatic sync) replaces it. */}
      {notice && !(notice.error === false && loaded?.phase === 'error') && <div className={`banner${notice.error ? ' error' : ''}`}>{notice.text}</div>}
      {loaded && loaded.setup !== 'ready' && !projectMissing && <SyncSetupPanel setup={loaded.setup} onDone={refresh} />}
      {loaded && loaded.conflicts > 0 && <ConflictsPanel onDone={refresh} syncing={loaded.phase === 'syncing'} />}
    </div>
  )
}

function SyncErrorNotice({ error }: { error: SyncError }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="banner error" role="alert">
      {t(`sync.errors.${error.code}`, { paths: pathList(error.paths) })}
    </div>
  )
}
