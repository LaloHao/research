import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MappingSummary } from '../../../shared/mapping'
import type { ThesisContext } from '../../../shared/summary'
import type { OutlineData, OutlineScope } from '../../../shared/writing/api'
import { buildOutline, renderOutline, type Outline, type OutlineEntry, type OutlineLabels } from '../../../shared/writing/outline'
import type { OutlineRequest } from '../../../shared/writing/outlineProposal'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { FILE_EXTENSIONS, type WritingPrefs } from '../../lib/writing'
import { OutlineProposal } from './OutlineProposal'
import { OutputFormat } from './OutputFormat'

type ScopeKind = OutlineScope['kind']

/**
 * «Esquema» (basic, no Claude): the chosen papers grouped by a main facet (and a secondary one), with their one-liner
 * and confirmed relations, the gaps and the unclassified papers; exported as Org, LaTeX or Markdown.
 */
export function OutlineTab({
  visibleIds,
  prefs,
  onPrefsChange
}: {
  visibleIds: string[] | null
  prefs: WritingPrefs
  onPrefsChange: (prefs: WritingPrefs) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [thesis, setThesis] = useState<ThesisContext | null>(null)
  const [mappings, setMappings] = useState<MappingSummary[]>([])
  const [questionId, setQuestionId] = useState('')
  const [scopeKind, setScopeKind] = useState<ScopeKind>('library')
  const [mappingId, setMappingId] = useState('')
  const [facet, setFacet] = useState('')
  const [secondary, setSecondary] = useState('')
  const [onlyReviewed, setOnlyReviewed] = useState(false)
  const [data, setData] = useState<OutlineData | null>(null)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)

  useEffect(() => {
    window.research.thesis.get().then(setThesis, () => setThesis(null))
    window.research.mappings.list().then(
      (list) => setMappings(list.filter((m) => !m.problem)),
      () => setMappings([])
    )
  }, [])

  const scope = useMemo((): OutlineScope | null => {
    if (scopeKind === 'library') return { kind: 'library' }
    if (scopeKind === 'papers') return visibleIds ? { kind: 'papers', ids: visibleIds } : null
    return mappingId ? { kind: 'mapping', mappingId } : null
  }, [scopeKind, visibleIds, mappingId])

  const load = useCallback(() => {
    if (!scope) {
      setData(null)
      return
    }
    window.research.writing.outlineData(scope).then(
      (r) => {
        if (r.ok) {
          setData(r.data)
          setNotice((n) => (n?.error ? null : n))
        } else setNotice({ error: true, text: errorText(t, r.error) })
      },
      () => setNotice({ error: true, text: errorText(t, 'unknown') })
    )
  }, [scope, t])
  useEffect(load, [load])
  useEvent('library-changed', load)
  useEvent('project-changed', load)

  // The first facet by default, and never a facet the form no longer has.
  useEffect(() => {
    if (!data) return
    const keys = data.facets.map((f) => f.key)
    if (!keys.includes(facet)) setFacet(keys[0] ?? '')
    if (secondary && !keys.includes(secondary)) setSecondary('')
  }, [data, facet, secondary])

  const question = thesis?.research_questions.find((q) => q.id === questionId) ?? null
  // What «Proponer redacción del esquema» sends: the main process builds the same outline again from it.
  const request = useMemo(
    (): Omit<OutlineRequest, 'model'> | null =>
      scope && facet ? { scope, facet, secondary: secondary && secondary !== facet ? secondary : null, onlyReviewed, questionId: question?.id ?? null } : null,
    [scope, facet, secondary, onlyReviewed, question]
  )
  const outline = useMemo((): Outline | null => {
    const main = data?.facets.find((f) => f.key === facet)
    if (!data || !main) return null
    const second = data.facets.find((f) => f.key === secondary && f.key !== facet) ?? null
    return buildOutline({ papers: data.papers, facet: main, secondary: second, relations: data.relations, onlyReviewed, question })
  }, [data, facet, secondary, onlyReviewed, question])

  const labels = useMemo(
    (): OutlineLabels => ({
      value: (_facet, value) => value.replace(/_/g, ' '),
      unclassified: t('writing.outline.unclassified'),
      gapValue: (value) => t('writing.outline.gap_value', { value }),
      gapCombination: (value, other) => t('writing.outline.gap_combination', { value, other }),
      relation: (type, from, to) => t(`typed.sentence.${type}`, { from, to }),
      header: (main, second, q) =>
        [t('writing.outline.header', { facet: main }), second ? t('writing.outline.header_secondary', { facet: second }) : '', q ? t('writing.outline.header_question', { id: q.id, text: q.text }) : '']
          .filter(Boolean)
          .join('; ')
    }),
    [t]
  )
  const exported = useMemo(() => (outline ? renderOutline(outline, { format: prefs.format, labels }) : ''), [outline, prefs.format, labels])

  const copy = (): void => {
    navigator.clipboard.writeText(exported).then(
      () => setNotice({ error: false, text: t('writing.copied') }),
      () => setNotice({ error: true, text: errorText(t, 'unknown') })
    )
  }
  const save = async (): Promise<void> => {
    try {
      const r = await window.research.exports.save(`${t('writing.outline.file_name')}.${FILE_EXTENSIONS[prefs.format]}`, exported)
      if (r.ok) setNotice({ error: false, text: t('writing.saved', { path: r.path }) })
      else if (r.error) setNotice({ error: true, text: errorText(t, r.error) })
    } catch {
      setNotice({ error: true, text: errorText(t, 'unknown') })
    }
  }

  return (
    <section className="writing-tab">
      <p className="muted">{t('writing.outline.intro')}</p>
      <div className="writing-controls">
        <label className="field">
          <span>{t('writing.outline.question')}</span>
          <select value={questionId} onChange={(e) => setQuestionId(e.target.value)}>
            <option value="">{t('writing.outline.no_question')}</option>
            {thesis?.research_questions.map((q) => (
              <option key={q.id} value={q.id}>
                {`${q.id}: ${q.text}`}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('writing.outline.facet')}</span>
          <select value={facet} onChange={(e) => setFacet(e.target.value)} disabled={!data?.facets.length}>
            {data?.facets.map((f) => (
              <option key={f.key} value={f.key}>
                {f.key}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('writing.outline.secondary')}</span>
          <select value={secondary} onChange={(e) => setSecondary(e.target.value)} disabled={!data?.facets.length}>
            <option value="">{t('writing.outline.no_secondary')}</option>
            {data?.facets
              .filter((f) => f.key !== facet)
              .map((f) => (
                <option key={f.key} value={f.key}>
                  {f.key}
                </option>
              ))}
          </select>
        </label>
        <div className="field">
          <span>{t('writing.outline.papers')}</span>
          <div className="row" role="radiogroup" aria-label={t('writing.outline.papers')}>
            <label className="row">
              <input type="radio" name="outline-scope" checked={scopeKind === 'library'} onChange={() => setScopeKind('library')} />
              <span>{t('writing.outline.scopes.library')}</span>
            </label>
            <label className="row">
              <input type="radio" name="outline-scope" checked={scopeKind === 'papers'} disabled={!visibleIds} onChange={() => setScopeKind('papers')} />
              <span>{visibleIds ? t('writing.outline.scopes.filtered', { count: visibleIds.length }) : t('writing.outline.scopes.filtered_unknown')}</span>
            </label>
            <label className="row">
              <input type="radio" name="outline-scope" checked={scopeKind === 'mapping'} disabled={mappings.length === 0} onChange={() => setScopeKind('mapping')} />
              <span>{t('writing.outline.scopes.mapping')}</span>
            </label>
            {scopeKind === 'mapping' && (
              <select aria-label={t('writing.outline.mapping')} value={mappingId} onChange={(e) => setMappingId(e.target.value)}>
                <option value="">{t('writing.outline.pick_mapping')}</option>
                {mappings.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <label className="field checkbox">
          <input type="checkbox" checked={onlyReviewed} onChange={(e) => setOnlyReviewed(e.target.checked)} />
          <span>{t('writing.outline.only_reviewed')}</span>
        </label>
      </div>
      {data && data.facets.length === 0 && <div className="banner warning">{t('writing.outline.no_facets')}</div>}
      {notice && (
        <div className={`banner${notice.error ? ' error' : ''}`} role="status">
          {notice.text}
        </div>
      )}
      {outline && (
        <>
          <p role="status">
            {t('writing.outline.summary', { papers: data!.papers.length, sections: outline.sections.length })}
            {outline.gaps.values.length + outline.gaps.combinations.length > 0 &&
              ` · ${t('writing.outline.count_gaps', { count: outline.gaps.values.length + outline.gaps.combinations.length })}`}
            {outline.unclassified.length > 0 && ` · ${t('writing.outline.count_unclassified', { count: outline.unclassified.length })}`}
          </p>
          <OutlinePreview outline={outline} labels={labels} />
          <div className="writing-export">
            <OutputFormat prefs={prefs} onChange={onPrefsChange} />
            <div className="row">
              <button onClick={copy}>{t('writing.copy')}</button>
              <button onClick={() => void save()}>{t('writing.outline.save')}</button>
            </div>
            <textarea className="writing-output" readOnly aria-label={t('writing.outline.output_label')} value={exported} />
          </div>
        </>
      )}
      <OutlineProposal outline={outline} format={prefs.format} latexCommand={prefs.latexCommand} request={request} labels={labels} />
    </section>
  )
}

function OutlinePreview({ outline, labels }: { outline: Outline; labels: OutlineLabels }): React.JSX.Element {
  const { t } = useTranslation()
  const sections = new Map(outline.sections.map((s) => [s.value, s]))
  return (
    <div className="writing-outline">
      {outline.values.map((value) => {
        const section = sections.get(value)
        if (!section) {
          return (
            <p key={value} className="writing-gap">
              {t('writing.outline.gap', { text: labels.gapValue(labels.value(outline.facet, value)) })}
            </p>
          )
        }
        return (
          <div key={value} className="writing-section">
            <h3>{labels.value(outline.facet, value)}</h3>
            <PaperList papers={section.papers} labels={labels} />
            {section.subsections.map((sub) => (
              <div key={sub.value} className="writing-subsection">
                <h4>{labels.value(outline.secondary!, sub.value)}</h4>
                <PaperList papers={sub.papers} labels={labels} />
              </div>
            ))}
            {outline.gaps.combinations
              .filter((c) => c.value === value)
              .map((c) => (
                <p key={c.secondary} className="writing-gap">
                  {t('writing.outline.gap', { text: labels.gapCombination(labels.value(outline.facet, c.value), labels.value(outline.secondary!, c.secondary)) })}
                </p>
              ))}
          </div>
        )
      })}
      {outline.unclassified.length > 0 && (
        <div className="writing-section">
          <h3>{labels.unclassified}</h3>
          <PaperList papers={outline.unclassified} labels={labels} />
        </div>
      )}
    </div>
  )
}

function PaperList({ papers, labels }: { papers: OutlineEntry[]; labels: OutlineLabels }): React.JSX.Element | null {
  if (papers.length === 0) return null
  return (
    <ul className="writing-papers">
      {papers.map((p) => (
        <li key={p.id}>
          <code>{p.id}</code> {p.title}
          {p.year !== null && ` (${p.year})`}
          {p.tldr && <div className="muted small">{p.tldr}</div>}
          {p.relations.length > 0 && <div className="small">{p.relations.map((r) => labels.relation(r.type, r.from, r.to)).join('; ')}</div>}
        </li>
      ))}
    </ul>
  )
}
