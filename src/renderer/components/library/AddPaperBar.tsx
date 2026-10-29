import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isWebAddress } from '../../lib/appBrowser'
import { errorText } from '../../lib/errorText'

export function AddPaperBar(): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    const input = value.trim()
    if (!input) return
    void window.research.library.addIdentifier(input)
    setValue('')
    setError(null)
  }
  /** «Abrir en navegador»: pages that refuse the app, need a login or are built by scripts are added from the app's browser. */
  const browse = (): void => {
    const input = value.trim()
    setError(null)
    window.research.library.openInBrowser(input).then(
      (result) => {
        if (result.ok) setValue('')
        else setError(errorText(t, result.error))
      },
      () => setError(errorText(t, 'unknown'))
    )
  }
  return (
    <form className="add-bar" onSubmit={submit}>
      <input value={value} placeholder={t('library.add_placeholder')} onChange={(e) => setValue(e.target.value)} />
      <button type="submit" className="primary" disabled={!value.trim()}>
        {t('library.add')}
      </button>
      <button type="button" disabled={!isWebAddress(value)} title={t('library.open_in_browser_hint')} onClick={browse}>
        {t('library.open_in_browser')}
      </button>
      {error && <span className="error small">{error}</span>}
    </form>
  )
}
