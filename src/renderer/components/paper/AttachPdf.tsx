import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorText } from '../../lib/errorText'
import { afterPick, droppedPdf, isFileDrag, type AttachStep } from '../../lib/attachPdf'

type Notice = { error: boolean; text: string } | null

export interface AttachPdf {
  busy: boolean
  dragging: boolean
  /** The picked or dropped file waiting for the user to confirm the replacement. */
  confirming: string | null
  notice: Notice
  pick: () => void
  confirm: () => void
  cancel: () => void
  /** Spread on the element that accepts a dropped PDF; marks it so the library-level drop ignores it. */
  dropProps: {
    'data-pdf-drop': true
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
}

/** Attaching (or, after a confirmation, replacing) the PDF of one paper from a file picker or a drop. */
export function useAttachPdf(paperId: string, hasPdf: boolean): AttachPdf {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  // Only the latest request may update the state: an older answer arriving late is ignored.
  const request = useRef(0)
  const busyRef = useRef(false)

  const setInFlight = useCallback((value: boolean) => {
    busyRef.current = value
    setBusy(value)
  }, [])

  const send = useCallback(
    (path: string, replace: boolean) => {
      const token = ++request.current
      setInFlight(true)
      setConfirming(null)
      setNotice(null)
      window.research.library.attachPdf(paperId, path, replace).then(
        () => {
          if (token !== request.current) return
          setInFlight(false)
          setNotice({ error: false, text: t('paper.attach.queued') })
        },
        () => {
          if (token !== request.current) return
          setInFlight(false)
          setNotice({ error: true, text: errorText(t, 'unknown') })
        }
      )
    },
    [paperId, setInFlight, t]
  )

  const apply = useCallback(
    (step: AttachStep) => {
      if (step.kind === 'send') send(step.path, step.replace)
      else if (step.kind === 'confirm') setConfirming(step.path)
    },
    [send]
  )

  const pick = useCallback(() => {
    if (busyRef.current) return
    const token = ++request.current
    setInFlight(true)
    setNotice(null)
    setConfirming(null)
    window.research.library.choosePdf().then(
      (path) => {
        if (token !== request.current) return
        setInFlight(false)
        apply(afterPick(path, hasPdf))
      },
      () => {
        if (token !== request.current) return
        setInFlight(false)
        setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }, [apply, hasPdf, setInFlight, t])

  const confirm = useCallback(() => {
    if (confirming && !busyRef.current) send(confirming, true)
  }, [confirming, send])
  const cancel = useCallback(() => setConfirming(null), [])

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e.dataTransfer.types)) return
    e.preventDefault()
    e.stopPropagation()
    setDragging(true)
  }, [])
  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
  }, [])
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!isFileDrag(e.dataTransfer.types)) return
      e.preventDefault()
      e.stopPropagation()
      setDragging(false)
      if (busyRef.current) return
      const file = droppedPdf(Array.from(e.dataTransfer.files))
      if (!file) {
        setNotice({ error: true, text: t('paper.attach.only_one_pdf') })
        return
      }
      setNotice(null)
      apply(afterPick(window.research.pathForFile(file), hasPdf))
    },
    [apply, hasPdf, t]
  )
  const dropProps = useMemo(() => ({ 'data-pdf-drop': true as const, onDragOver, onDragLeave, onDrop }), [onDragOver, onDragLeave, onDrop])

  return { busy, dragging, confirming, notice, pick, confirm, cancel, dropProps }
}

/** The replacement confirmation and the last notice (queued, or why nothing happened). */
export function AttachPdfStatus({ attach }: { attach: AttachPdf }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (attach.confirming) {
    return (
      <div className="banner warning attach-confirm">
        <span>{t('paper.attach.confirm')}</span>
        <span className="muted">{t('paper.attach.confirm_file', { file: attach.confirming.split(/[\\/]/).pop() })}</span>
        <div className="row">
          <button className="primary" disabled={attach.busy} onClick={attach.confirm}>
            {t('paper.attach.confirm_replace')}
          </button>
          <button disabled={attach.busy} onClick={attach.cancel}>
            {t('paper.attach.cancel')}
          </button>
        </div>
      </div>
    )
  }
  if (!attach.notice) return null
  return <p className={`attach-notice ${attach.notice.error ? 'error' : 'muted'}`}>{attach.notice.text}</p>
}
