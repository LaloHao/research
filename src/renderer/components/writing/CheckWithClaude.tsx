import { useTranslation } from 'react-i18next'
import type { CitationReport, CiteFormat } from '../../../shared/writing/citations'
import { ComingSoon } from './ComingSoon'

/**
 * «Verificar con Claude» (cost kind `cite_check`, cap `per_cite_check_usd`): placeholder. The citation-check task
 * replaces this component: it gets the local step's report (null while there is nothing to check), the pasted text
 * and its format.
 */
export function CheckWithClaude(_props: { report: CitationReport | null; text: string; format: CiteFormat }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="writing-claude">
      <h3>{t('writing.check.claude_title')}</h3>
      <p className="muted small">{t('writing.check.claude_intro')}</p>
      <ComingSoon label={t('writing.check.claude_run')} />
    </div>
  )
}
