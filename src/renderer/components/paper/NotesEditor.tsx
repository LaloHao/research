import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEvent } from '../../hooks/useEvent'
import { onFlush } from '../../lib/flush'

type Status = 'idle' | 'saving' | 'saved' | 'conflict'

const SAVE_DELAY_MS = 800

/** Autosaving notes.md editor that never overwrites an external edit silently. Mount it with `key={paperId}`. */
export function NotesEditor({ paperId }: { paperId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const hash = useRef<string | null>(null)
  const dirty = useRef(false)
  const latest = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Saves run one after another so each one uses the hash the previous one produced.
  const saving = useRef<Promise<void>>(Promise.resolve())

  const load = useCallback(async () => {
    const notes = await window.research.library.readNotes(paperId)
    hash.current = notes.hash
    dirty.current = false
    latest.current = notes.text
    setText(notes.text)
    setStatus('idle')
  }, [paperId])

  const save = useCallback(
    (value: string): Promise<void> => {
      const run = saving.current.then(async () => {
        setStatus('saving')
        const result = await window.research.library.writeNotes(paperId, value, hash.current)
        if (result.ok) {
          hash.current = result.hash
          if (latest.current === value) dirty.current = false
          setStatus('saved')
        } else {
          setStatus('conflict')
        }
      })
      saving.current = run.catch((error: unknown) => console.error('notes', error))
      return saving.current
    },
    [paperId]
  )

  /** Saves a pending edit now instead of after the autosave delay. */
  const flush = useCallback((): Promise<void> => {
    clearTimeout(timer.current)
    return dirty.current ? save(latest.current) : saving.current
  }, [save])

  useEffect(() => {
    void load().catch((error: unknown) => console.error('notes', error))
    const off = onFlush(flush)
    // Leaving this paper flushes a pending edit instead of dropping it.
    return () => {
      off()
      void flush()
    }
  }, [load, flush])

  useEvent('library-changed', () => {
    if (!dirty.current && status !== 'conflict') void load().catch(() => undefined)
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
          <button onClick={() => void load().catch(() => undefined)}>{t('notes.reload')}</button>
          <button onClick={() => void overwrite().catch(() => undefined)}>{t('notes.overwrite')}</button>
        </div>
      )}
      <textarea value={text} placeholder={t('notes.placeholder')} onChange={(e) => onChange(e.target.value)} />
      <div className="muted small">{status === 'saving' ? t('notes.saving') : status === 'saved' ? t('notes.saved') : ''}</div>
    </div>
  )
}
