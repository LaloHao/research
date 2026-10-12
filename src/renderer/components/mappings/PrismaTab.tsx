import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MappingView } from '../../../shared/mapping'
import { errorText } from '../../lib/errorText'
import { prismaFileName, prismaLabels } from '../../lib/mappings'
import { prismaSvg } from '../../lib/prismaSvg'
import { svgToPng } from '../../lib/svgPng'

/** The diagram is for documents: it keeps its own print colors and a white background whatever the app's theme. */
const PAPER = '#ffffff'

/** «PRISMA»: the PRISMA 2020 flow diagram of the mapping, recomputed from its log and current decisions on every reload. */
export function PrismaTab({ view }: { view: MappingView }): React.JSX.Element {
  const { t } = useTranslation()
  const diagram = useMemo(() => prismaSvg(view.prisma, prismaLabels(t, view.protocol)), [view.prisma, view.protocol, t])
  const source = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(diagram.svg)}`, [diagram])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const inconsistent = view.inconsistentSearches.length

  const save = async (ext: 'svg' | 'png'): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      const payload = ext === 'svg' ? diagram.svg : await svgToPng(diagram.svg, diagram.width, diagram.height, PAPER)
      const result = await window.research.exports.save(prismaFileName(view.protocol.protocol.title, ext), payload)
      if (result.ok) setNotice({ error: false, text: t('mappings.prisma.exported', { path: result.path }) })
      else if (result.error) setNotice({ error: true, text: errorText(t, result.error) })
    } catch {
      setNotice({ error: true, text: errorText(t, 'unknown') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="prisma">
      <div className="row small">
        <strong>{t('mappings.prisma.title')}</strong>
        <button disabled={busy} onClick={() => void save('svg')}>
          {t('mappings.prisma.export_svg')}
        </button>
        <button disabled={busy} onClick={() => void save('png')}>
          {t('mappings.prisma.export_png')}
        </button>
      </div>
      <p className="muted small">{t('mappings.prisma.note')}</p>
      {inconsistent > 0 && <div className="banner warning" role="status">{t('mappings.prisma.inconsistent', { count: inconsistent })}</div>}
      {notice && <div className={`banner${notice.error ? ' error' : ''}`}>{notice.text}</div>}
      <div className="prisma-holder">
        <img className="prisma-diagram" alt={t('mappings.prisma.alt')} width={diagram.width} height={diagram.height} src={source} />
      </div>
    </div>
  )
}
