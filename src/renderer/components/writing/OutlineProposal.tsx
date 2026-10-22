import { useTranslation } from 'react-i18next'
import type { CiteFormat } from '../../../shared/writing/citations'
import type { Outline } from '../../../shared/writing/outline'
import { ComingSoon } from './ComingSoon'

/**
 * «Proponer redacción del esquema» (cost kind `outline`, cap `per_outline_usd`): placeholder. The outline-proposal task
 * replaces this component: it gets the basic outline (null until there is one) and the chosen output format.
 */
export function OutlineProposal(_props: { outline: Outline | null; format: CiteFormat }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="writing-claude">
      <h3>{t('writing.outline.claude_title')}</h3>
      <p className="muted small">{t('writing.outline.claude_intro')}</p>
      <ComingSoon label={t('writing.outline.claude_run')} />
    </div>
  )
}
