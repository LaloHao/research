import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PaperRow } from '../../../shared/library'
import { useEvent } from '../../hooks/useEvent'
import { PaperDetail } from '../paper/PaperDetail'
import { AddPaperBar } from './AddPaperBar'
import { JobsPanel } from './JobsPanel'
import { PaperList } from './PaperList'

export function LibraryView(): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<PaperRow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const refresh = useCallback(() => {
    void window.research.library.list(query).then(setRows)
  }, [query])
  useEffect(() => {
    const handle = setTimeout(refresh, 150)
    return () => clearTimeout(handle)
  }, [refresh])
  useEvent('library-changed', refresh)

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    const paths = Array.from(e.dataTransfer.files)
      .filter((f) => f.name.toLowerCase().endsWith('.pdf'))
      .map((f) => window.research.pathForFile(f))
    if (paths.length) void window.research.library.addPdfs(paths)
  }

  return (
    <div
      className={`library${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <aside className="library-list">
        <input className="search" type="search" value={query} placeholder={t('library.search_placeholder')} onChange={(e) => setQuery(e.target.value)} />
        <AddPaperBar />
        <PaperList rows={rows} query={query} selected={selected} onSelect={setSelected} />
        <JobsPanel onSelectPaper={setSelected} />
      </aside>
      <section className="library-detail">
        {selected ? <PaperDetail id={selected} /> : <div className="center muted">{t('library.select_hint')}</div>}
      </section>
      {dragging && <div className="drop-overlay">{t('library.drop_hint')}</div>}
    </div>
  )
}
