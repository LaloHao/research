import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConflictDiff, DiffFile } from '../../../shared/sync'
import { errorText } from '../../lib/errorText'
import { lineDiff } from '../../lib/sync'

/**
 * «Ver diferencias»: this machine's version and the other machine's, side by side. `revision` changes whenever the
 * conflicts are listed again, so a conflict whose versions changed meanwhile is read again.
 */
export function ConflictDiffView({ id, revision }: { id: string; revision: number }): React.JSX.Element {
  const { t } = useTranslation()
  const [diff, setDiff] = useState<ConflictDiff | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    setDiff(null)
    setFailed(false)
    window.research.sync.diff(id).then(
      (next) => {
        if (live) setDiff(next)
      },
      () => {
        if (live) setFailed(true)
      }
    )
    return () => {
      live = false
    }
  }, [id, revision])

  if (failed) return <p className="field-error">{errorText(t, 'unknown')}</p>
  if (!diff) return <p className="muted small">{t('sync.conflicts.loading_diff')}</p>
  return (
    <div className="sync-diff">
      {diff.files.map((file) => (
        <DiffTable key={file.path} file={file} />
      ))}
    </div>
  )
}

function DiffTable({ file }: { file: DiffFile }): React.JSX.Element {
  const { t } = useTranslation()
  const rows = useMemo(() => (file.unavailable ? [] : lineDiff(file.ours ?? '', file.theirs ?? '')), [file])
  return (
    <div className="sync-diff-file">
      <div className="muted small">{file.path}</div>
      {file.unavailable ? (
        <p className="muted small">{t(`sync.conflicts.diff_${file.unavailable}`)}</p>
      ) : (
        <table className="sync-diff-table">
          <thead>
            <tr>
              <th>
                {t('sync.conflicts.diff_mine')}
                {file.ours === null && ` ${t('sync.conflicts.diff_deleted')}`}
              </th>
              <th>
                {t('sync.conflicts.diff_theirs')}
                {file.theirs === null && ` ${t('sync.conflicts.diff_deleted')}`}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={`diff-${row.kind}`}>
                <td>{row.left ?? ''}</td>
                <td>{row.right ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
