import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEvent } from '../../hooks/useEvent'

type Status = 'idle' | 'saving' | 'saved' | 'conflict'

const SAVE_DELAY_MS = 800

/** Autosaving notes.md editor that never overwrites an external edit silently. */
export function NotesEditor({ paperId }: { paperId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const hash = useRef<string | null>(null)
  const dirty = useRef(false)
  const latest = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const load = useCallback(async () => {
    const notes = await window.research.library.readNotes(paperId)
    hash.current = notes.hash
    dirty.current = false
    latest.current = notes.text
    setText(notes.text)
    setStatus('idle')
  }, [paperId])

  const save = useCallback(
    async (value: string) => {
      setStatus('saving')
      const result = await window.research.library.writeNotes(paperId, value, hash.current)
      if (result.ok) {
        hash.current = result.hash
        dirty.current = false
        setStatus('saved')
      } else {
        setStatus('conflict')
      }
    },
    [paperId]
  )

  useEffect(() => {
    void load()
    // Leaving this paper flushes a pending edit instead of dropping it.
    return () => {
      clearTimeout(timer.current)
      if (dirty.current) void save(latest.current)
    }
  }, [load, save])

  useEvent('library-changed', () => {
    if (!dirty.current && status !== 'conflict') void load()
  })

  const onChange = (value: string): void => {
    setText(value)
    latest.current = value
    dirty.current = true
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(value), SAVE_DELAY_MS)
  }

  const overwrite = async (): Promise<void> => {
    hash.current = (await window.research.library.readNotes(paperId)).hash
    await save(latest.current)
  }

  return (
    <div className="notes">
      {status === 'conflict' && (
        <div className="banner warning">
          {t('notes.conflict')}
          <button onClick={() => void load()}>{t('notes.reload')}</button>
          <button onClick={() => void overwrite()}>{t('notes.overwrite')}</button>
        </div>
      )}
      <textarea value={text} placeholder={t('notes.placeholder')} onChange={(e) => onChange(e.target.value)} />
      <div className="muted small">{status === 'saving' ? t('notes.saving') : status === 'saved' ? t('notes.saved') : ''}</div>
    </div>
  )
}
