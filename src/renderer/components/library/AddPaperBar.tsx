import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export function AddPaperBar(): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    const input = value.trim()
    if (!input) return
    void window.research.library.addIdentifier(input)
    setValue('')
  }
  return (
    <form className="add-bar" onSubmit={submit}>
      <input value={value} placeholder={t('library.add_placeholder')} onChange={(e) => setValue(e.target.value)} />
      <button type="submit" className="primary" disabled={!value.trim()}>
        {t('library.add')}
      </button>
    </form>
  )
}
