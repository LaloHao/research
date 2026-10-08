import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export function MetadataCompletion({ paperId, hasIdentifier }: { paperId: string; hasIdentifier: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!input.trim()) return
    void window.research.library.updateMetadata(paperId, input.trim())
    setInput('')
  }
  return (
    <div className="banner warning">
      <span>{t('paper.metadata.incomplete')}</span>
      {hasIdentifier && <button onClick={() => void window.research.library.updateMetadata(paperId)}>{t('paper.metadata.retry')}</button>}
      <form className="row" onSubmit={submit}>
        <input value={input} placeholder={t('paper.metadata.input_placeholder')} onChange={(e) => setInput(e.target.value)} />
        <button type="submit" disabled={!input.trim()}>
          {t('paper.metadata.apply')}
        </button>
      </form>
    </div>
  )
}
