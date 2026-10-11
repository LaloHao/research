import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SyncSetup } from '../../../shared/sync'
import { errorText } from '../../lib/errorText'
import { remoteUrlProblem } from '../../lib/sync'

/** First use: «Inicializar repositorio» (with an optional remote), «Agregar remoto y sincronizar» or «Conectar y sincronizar». */
export function SyncSetupPanel({ setup, onDone }: { setup: Exclude<SyncSetup, 'ready'>; onDone: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // The problem is the typed URL itself (marks the field).
  const [badUrl, setBadUrl] = useState(false)
  // Optional with a repository to create, required to add a remote, and a way to correct a mistyped one while the branch
  // still follows nothing (the first sync with it failed).
  const showsUrl = setup !== 'no_git'

  const submit = (): void => {
    if (busy) return
    const typed = url.trim()
    // The URL is required to add a remote, optional when only initializing the repository.
    const issue = setup === 'no_remote' || typed !== '' ? remoteUrlProblem(typed) : null
    if (issue) {
      setProblem(t(`sync.setup.url_${issue}`))
      setBadUrl(true)
      return
    }
    setBusy(true)
    setProblem(null)
    window.research.sync.init(typed !== '' ? typed : null).then(
      () => {
        setBusy(false)
        // A failure is kept in the status and shown by the Sync view's banner; initialized without a remote, the panel
        // simply asks for one next.
        onDone()
      },
      () => {
        setBusy(false)
        setProblem(errorText(t, 'unknown'))
        onDone()
      }
    )
  }

  const action = setup === 'no_repo' ? 'sync.setup.init' : setup === 'no_remote' ? 'sync.setup.add_remote' : 'sync.setup.connect'
  return (
    <section className="sync-setup">
      <p>{t(`sync.setup.${setup}`)}</p>
      {showsUrl && (
        <label className="field">
          <span>{t('sync.setup.url_label')}</span>
          <input
            value={url}
            spellCheck={false}
            autoComplete="off"
            placeholder={t('sync.setup.url_placeholder')}
            disabled={busy}
            className={badUrl ? 'invalid' : undefined}
            aria-invalid={badUrl}
            onChange={(e) => {
              setUrl(e.target.value)
              setProblem(null)
              setBadUrl(false)
            }}
          />
          <small className="muted">{t(setup === 'no_upstream' ? 'sync.setup.url_fix_help' : 'sync.setup.url_help')}</small>
        </label>
      )}
      {setup !== 'no_git' && (
        <div className="row">
          <button className="primary" disabled={busy} onClick={submit}>
            {t(action)}
          </button>
        </div>
      )}
      {problem && <p className="field-error">{problem}</p>}
    </section>
  )
}
