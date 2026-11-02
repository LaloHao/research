import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { newKeyProblem } from '../../lib/changeKey'
import { errorText } from '../../lib/errorText'
import { trapTab } from '../../lib/focusTrap'

/**
 * «Cambiar» next to the citation key: a dialog with the key the paper's current metadata gives (editable). Saving
 * renames the paper and every reference to it in the project; citations the user wrote elsewhere keep the old key,
 * which the dialog says. `onChanged` gets the new key (the host selects it).
 */
export function ChangeKey({ id, onChanged }: { id: string; onChanged?: (key: string) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [id])
  return (
    <>
      <button className="small" onClick={() => setOpen(true)}>
        {t('paper.change_key.open')}
      </button>
      {open && (
        <ChangeKeyDialog
          id={id}
          onCancel={() => setOpen(false)}
          onSaved={(key) => {
            setOpen(false)
            onChanged?.(key)
          }}
        />
      )}
    </>
  )
}

function ChangeKeyDialog({ id, onCancel, onSaved }: { id: string; onCancel: () => void; onSaved: (key: string) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const titleId = useId()
  const [value, setValue] = useState<string | null>(null)
  const [same, setSame] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    window.research.library.suggestKey(id).then(
      (s) => {
        if (!live) return
        setValue(s.key)
        setSame(s.same)
      },
      () => {
        if (!live) return
        setValue(id)
        setError(errorText(t, 'unknown'))
      }
    )
    return () => {
      live = false
    }
  }, [id, t])

  const save = (e: React.FormEvent): void => {
    e.preventDefault()
    if (value === null || busy) return
    const problem = newKeyProblem(value, id)
    if (problem) {
      setError(errorText(t, problem))
      return
    }
    setBusy(true)
    setError(null)
    window.research.library.changeKey(id, value.trim()).then(
      (r) => {
        setBusy(false)
        if (r.ok) onSaved(r.key)
        else setError(errorText(t, r.error))
      },
      () => {
        setBusy(false)
        setError(errorText(t, 'unknown'))
      }
    )
  }

  return (
    <div className="modal-backdrop">
      <form
        className="modal change-key"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={save}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            if (!busy) onCancel()
          } else trapTab(e)
        }}
      >
        <h3 id={titleId}>{t('paper.change_key.title')}</h3>
        <p className="small">
          {t('paper.change_key.current')}: <code>{id}</code>
        </p>
        {value === null ? (
          <p className="muted small">{t('app.loading')}</p>
        ) : (
          <label>
            {t('paper.change_key.new')}
            <input
              autoFocus
              value={value}
              spellCheck={false}
              onChange={(e) => {
                setValue(e.target.value)
                setError(null)
              }}
            />
          </label>
        )}
        <p className="muted small">{t(same ? 'paper.change_key.same_hint' : 'paper.change_key.suggested_hint')}</p>
        <p className="warning-text small">{t('paper.change_key.warning')}</p>
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <button type="submit" className="primary" disabled={busy || value === null}>
            {busy ? t('paper.change_key.saving') : t('paper.change_key.save')}
          </button>
          <button type="button" disabled={busy} onClick={onCancel}>
            {t('paper.change_key.cancel')}
          </button>
        </div>
      </form>
    </div>
  )
}
