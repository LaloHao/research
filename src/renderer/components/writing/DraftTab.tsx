import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MappingSummary } from '../../../shared/mapping'
import type { PaperDetail } from '../../../shared/library'
import { LLM_MODELS, type LlmModel, type ThesisContext } from '../../../shared/summary'
import type { WritingLibrary, WritingPlan } from '../../../shared/writing/api'
import {
  DRAFT_LENGTHS,
  DRAFT_WORDS,
  exportDraft,
  MAX_DRAFT_PAPERS,
  type DraftCheck,
  type DraftCitation,
  type DraftInput,
  type DraftLength,
  type DraftStreamUpdate,
  type DraftSummary,
  type DraftView
} from '../../../shared/writing/draft'
import { useEvent } from '../../hooks/useEvent'
import { useProjectModel } from '../../hooks/useProjectModel'
import { citationLabel } from '../../../shared/chatCitations'
import { costText, hidePartialMarker } from '../../lib/chat'
import { applyDraftUpdate, draftFileName, draftPapers, draftTitle, liveFromPartial, planLines, type LiveDraft } from '../../lib/drafts'
import { errorText } from '../../lib/errorText'
import { onFlush } from '../../lib/flush'
import type { WritingPrefs } from '../../lib/writing'
import { EvidencePanel, type Picked } from '../review/EvidencePanel'
import { OutputFormat } from './OutputFormat'

/** How long an edit waits before it is saved and its citations checked again. */
const EDIT_DELAY_MS = 800

interface DraftTabProps {
  library: WritingLibrary | null
  /** The library's visible rows (its filters), for «Los filtrados en la biblioteca»; null until the library was shown. */
  visibleIds: string[] | null
  prefs: WritingPrefs
  onPrefsChange: (prefs: WritingPrefs) => void
}

/**
 * «Borrador»: Claude drafts a section from the papers you choose, each claim with a verified citation; you edit the
 * text, regenerate it as a new version, and copy or save it as Org, LaTeX or Markdown. Drafts live in drafts/.
 */
export function DraftTab({ library, visibleIds, prefs, onPrefsChange }: DraftTabProps): React.JSX.Element {
  const { t } = useTranslation()
  const [list, setList] = useState<DraftSummary[]>([])
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  /** The open draft; null for a new one. */
  const [selected, setSelected] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<{ detail: PaperDetail; picked: Picked } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadList = useCallback(() => {
    window.research.drafts.list(query.trim() ? { text: query } : undefined).then(setList, () => setList([]))
  }, [query])
  useEffect(loadList, [loadList])
  useEvent('drafts-changed', loadList)

  const evidenceSeq = useRef(0)
  const openCitation = useCallback(
    (c: DraftCitation) => {
      const token = ++evidenceSeq.current
      window.research.library.detail(c.paper).then(
        (detail) => {
          if (token === evidenceSeq.current) setEvidence({ detail, picked: { page: c.page, quote: c.quote } })
        },
        () => {
          if (token === evidenceSeq.current) setError(errorText(t, 'unknown'))
        }
      )
    },
    [t]
  )

  const shown = list.filter((d) => showArchived || !d.archived)
  return (
    <div className="draft-view">
      <aside className="draft-side">
        <button className="primary" onClick={() => setSelected(null)}>
          {t('writing.draft.new')}
        </button>
        <input type="search" placeholder={t('writing.draft.search')} aria-label={t('writing.draft.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="row small">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          <span>{t('writing.draft.show_archived')}</span>
        </label>
        {shown.length === 0 && <p className="muted small">{query.trim() ? t('writing.draft.no_match') : t('writing.draft.none')}</p>}
        <ul className="plain-list">
          {shown.map((d) => (
            <li key={d.id}>
              <button className={`chat-list-item${selected === d.id ? ' active' : ''}`} onClick={() => setSelected(d.id)}>
                <span>{d.problem ? t('writing.draft.unreadable', { id: d.id }) : draftTitle(t, d)}</span>
                {!d.problem && (
                  <span className="muted small">
                    {t('writing.draft.list_meta', { count: d.versions, papers: d.papers, cost: costText(d.costUsd) })}
                    {d.archived && ` · ${t('writing.draft.archived')}`}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="writing-tab draft-main">
        <p className="muted">{t('writing.draft.intro')}</p>
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        <DraftEditor
          key={selected ?? 'new'}
          draftId={selected}
          library={library}
          visibleIds={visibleIds}
          prefs={prefs}
          onPrefsChange={onPrefsChange}
          onCreated={setSelected}
          onDeleted={() => setSelected(null)}
          onOpenCitation={openCitation}
        />
      </section>
      {evidence && (
        <aside className="chat-evidence">
          <div className="row chat-evidence-head">
            <strong>{evidence.detail.paper?.title ?? evidence.detail.id}</strong>
            <button className="small" onClick={() => setEvidence(null)}>
              {t('chat.close_evidence')}
            </button>
          </div>
          <EvidencePanel detail={evidence.detail} evidence={evidence.picked} />
        </aside>
      )}
    </div>
  )
}

interface EditorProps {
  draftId: string | null
  library: WritingLibrary | null
  visibleIds: string[] | null
  prefs: WritingPrefs
  onPrefsChange: (prefs: WritingPrefs) => void
  onCreated: (id: string) => void
  onDeleted: () => void
  onOpenCitation: (c: DraftCitation) => void
}

const emptyInput = (model: LlmModel): DraftInput => ({ title: '', purpose: '', rq: null, papers: [], length: 'medium', model })

/** One draft (or a new one): its form, the version being written, its versions with their citations, and the export. */
function DraftEditor({ draftId, library, visibleIds, prefs, onPrefsChange, onCreated, onDeleted, onOpenCitation }: EditorProps): React.JSX.Element {
  const { t } = useTranslation()
  const projectModel = useProjectModel()
  const [view, setView] = useState<DraftView | null>(null)
  const [input, setInput] = useState<DraftInput>(() => emptyInput(projectModel))
  const modelTouched = useRef(false)
  const formTouched = useRef(false)
  const [live, setLive] = useState<LiveDraft | null>(null)
  const [plan, setPlan] = useState<WritingPlan | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** The version shown (the current one by default). */
  const [shownVersion, setShownVersion] = useState<number | null>(null)
  /** The current version's text as edited here, and its check after the last save. */
  const [text, setText] = useState('')
  const [editCheck, setEditCheck] = useState<DraftCheck | null>(null)
  const dirty = useRef(false)
  /** An edit is waiting to be saved and checked: the chips and the export would follow the text as it was before. */
  const [checking, setChecking] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [quotes, setQuotes] = useState(false)
  const loadSeq = useRef(0)
  const liveRef = useRef<LiveDraft | null>(null)
  liveRef.current = live

  useEffect(() => {
    if (!draftId && !modelTouched.current) setInput((i) => ({ ...i, model: projectModel }))
  }, [draftId, projectModel])

  const load = useCallback(() => {
    if (!draftId) return
    const token = ++loadSeq.current
    window.research.drafts.open(draftId).then(
      (r) => {
        if (token !== loadSeq.current) return
        if (!r.ok) return setError(errorText(t, r.error))
        setView(r.draft)
        // The form follows the file until the user changes it (then it holds what «Regenerar» will use).
        if (!formTouched.current) setInput(r.draft.input)
        setLive(r.draft.partial ? liveFromPartial(r.draft.partial) : (l) => (l?.status === 'error' ? l : null))
        // An edit not saved yet is kept: the file's text replaces it only when there is none.
        if (!dirty.current) {
          setText(r.draft.versions.at(-1)?.text ?? '')
          setEditCheck(null)
        }
      },
      () => {
        if (token === loadSeq.current) setError(errorText(t, 'unknown'))
      }
    )
  }, [draftId, t])
  useEffect(load, [load])
  useEvent('drafts-changed', load)
  useEvent('library-changed', load)

  useEffect(
    () =>
      window.research.drafts.onStream((u: DraftStreamUpdate) => {
        if (u.draftId !== draftId) return
        const next = applyDraftUpdate(liveRef.current, u)
        liveRef.current = next.live
        setLive(next.live)
        if (u.kind === 'error') setError(errorText(t, u.error))
        if (next.resync) load()
      }),
    [draftId, load, t]
  )

  const textRef = useRef(text)
  textRef.current = text
  /** Saves the pending edit now (and checks its citations); nothing when there is none. */
  const save = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (!draftId || !dirty.current) return
    dirty.current = false
    const r = await window.research.drafts.edit(draftId, textRef.current).catch(() => ({ ok: false as const, error: 'unknown' }))
    if (r.ok) setEditCheck(r.check)
    else setError(errorText(t, r.error))
    if (!dirty.current) setChecking(false)
  }, [draftId, t])
  useEffect(() => {
    const off = onFlush(save)
    return () => {
      off()
      void save()
    }
  }, [save])

  const edit = (next: string): void => {
    setText(next)
    dirty.current = true
    setChecking(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(), EDIT_DELAY_MS)
  }

  const running = live?.status === 'running'
  const versions = view?.versions ?? []
  const current = versions.length - 1
  const index = shownVersion !== null && shownVersion < versions.length ? shownVersion : current
  const isCurrent = index === current
  const version = versions[index] ?? null
  const shownText = isCurrent ? text : (version?.text ?? '')
  const check = isCurrent ? (editCheck ?? version?.check ?? null) : (version?.check ?? null)
  const exported = useMemo(
    () => (check && shownText ? exportDraft(shownText, check, { format: prefs.format, latexCommand: prefs.latexCommand, quotes }) : null),
    [check, shownText, prefs, quotes]
  )

  const { papers, over } = draftPapers(input.papers)
  const canRun = !running && !pending && input.title.trim().length > 0 && papers.length > 0 && !over

  const askPlan = (): void => {
    setError(null)
    setPending(true)
    window.research.drafts.plan().then(
      (p) => {
        setPending(false)
        setPlan(p)
      },
      () => {
        setPending(false)
        setError(errorText(t, 'unknown'))
      }
    )
  }
  const run = async (): Promise<void> => {
    setPlan(null)
    setPending(true)
    setError(null)
    await save()
    try {
      const r = await window.research.drafts.run({ ...input, papers }, draftId, true)
      if (!r.ok) setError(errorText(t, r.error))
      else {
        setShownVersion(null)
        if (!draftId) onCreated(r.draftId)
      }
    } catch {
      setError(errorText(t, 'unknown'))
    } finally {
      setPending(false)
    }
  }

  const act = (work: () => Promise<{ ok: boolean; error?: string }>, after?: () => void): void => {
    setError(null)
    work().then(
      (r) => {
        if (!r.ok) setError(errorText(t, r.error ?? 'unknown'))
        else after?.()
      },
      () => setError(errorText(t, 'unknown'))
    )
  }

  const copy = (): void => {
    if (!exported) return
    navigator.clipboard.writeText(exported.text).then(
      () => setNotice(t('writing.copied')),
      () => setError(errorText(t, 'unknown'))
    )
  }
  const saveFile = async (): Promise<void> => {
    if (!exported) return
    try {
      const r = await window.research.exports.save(draftFileName(view?.summary.title ?? input.title, prefs.format), exported.text)
      if (r.ok) setNotice(t('writing.saved', { path: r.path }))
      else if (r.error) setError(errorText(t, r.error))
    } catch {
      setError(errorText(t, 'unknown'))
    }
  }

  const summary = view?.summary ?? null
  return (
    <div className="draft-editor">
      {summary && (
        <header className="row draft-header">
          {renaming !== null ? (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault()
                if (!renaming.trim()) return
                act(
                  () => window.research.drafts.rename(summary.id, renaming),
                  () => setRenaming(null)
                )
              }}
            >
              <input aria-label={t('writing.draft.rename')} value={renaming} onChange={(e) => setRenaming(e.target.value)} autoFocus />
              <button type="submit">{t('writing.draft.save_title')}</button>
              <button type="button" onClick={() => setRenaming(null)}>
                {t('writing.draft.cancel')}
              </button>
            </form>
          ) : (
            <>
              <h3>{draftTitle(t, summary)}</h3>
              <span className="muted small">{t('writing.draft.total_cost', { cost: costText(summary.costUsd) })}</span>
              <button className="small" disabled={running} onClick={() => setRenaming(summary.title)}>
                {t('writing.draft.rename')}
              </button>
              <button className="small" onClick={() => act(() => window.research.drafts.archive(summary.id, !summary.archived))}>
                {summary.archived ? t('writing.draft.unarchive') : t('writing.draft.archive')}
              </button>
              <button className="small" disabled={running} onClick={() => setConfirmDelete(true)}>
                {t('writing.draft.delete')}
              </button>
            </>
          )}
        </header>
      )}
      {confirmDelete && summary && (
        <div className="banner warning" role="alertdialog">
          <p>{t('writing.draft.delete_confirm', { title: summary.title })}</p>
          <div className="row">
            <button
              className="danger"
              onClick={() => {
                setConfirmDelete(false)
                act(() => window.research.drafts.remove(summary.id, true), onDeleted)
              }}
            >
              {t('writing.draft.delete')}
            </button>
            <button onClick={() => setConfirmDelete(false)}>{t('writing.draft.cancel')}</button>
          </div>
        </div>
      )}
      <DraftForm
        input={input}
        onChange={(next) => {
          if (next.model !== input.model) modelTouched.current = true
          formTouched.current = true
          setInput(next)
        }}
        library={library}
        visibleIds={visibleIds}
        disabled={running}
      />
      {over && <div className="banner warning">{t('writing.draft.too_many', { max: MAX_DRAFT_PAPERS })}</div>}
      <div className="row">
        <button className="primary" disabled={!canRun} onClick={askPlan}>
          {draftId ? t('writing.draft.regenerate') : t('writing.draft.run')}
        </button>
        {running && draftId && <button onClick={() => void window.research.drafts.stop(draftId)}>{t('writing.draft.stop')}</button>}
      </div>
      {plan && (
        <div className="banner" role="dialog" aria-label={t('writing.draft.confirm_title')}>
          <strong>{draftId ? t('writing.draft.confirm_regenerate', { model: input.model }) : t('writing.draft.confirm_run', { model: input.model })}</strong>
          {planLines(t, plan).map((line) => (
            <p key={line}>{line}</p>
          ))}
          <div className="row">
            <button className="primary" onClick={() => void run()}>
              {t('writing.draft.confirm')}
            </button>
            <button onClick={() => setPlan(null)}>{t('writing.draft.cancel')}</button>
          </div>
        </div>
      )}
      {error && (
        <div className="banner error" role="alert">
          {error}
          {!running && draftId && canRun && (
            <button className="small" onClick={askPlan}>
              {t('writing.draft.retry')}
            </button>
          )}
        </div>
      )}
      {notice && (
        <div className="banner" role="status">
          {notice}
        </div>
      )}
      {live?.status === 'running' && (
        <div className="draft-live" aria-live="polite">
          <p className="muted small">{live.tools > 0 ? t('writing.draft.writing_tools', { count: live.tools }) : t('writing.draft.writing')}</p>
          <div className="writing-sentence">{hidePartialMarker(live.text)}</div>
        </div>
      )}
      {versions.length > 0 && (
        <div className="draft-version">
          <div className="row">
            <label className="row">
              <span>{t('writing.draft.version')}</span>
              <select value={index} onChange={(e) => setShownVersion(Number(e.target.value))}>
                {versions.map((v, i) => (
                  <option key={i} value={i}>
                    {t('writing.draft.version_option', { n: i + 1, at: v.at.slice(0, 16).replace('T', ' '), model: v.model, cost: costText(v.costUsd) })}
                    {v.stopped ? ` · ${t('writing.draft.stopped')}` : ''}
                    {i === current ? ` · ${t('writing.draft.current')}` : ''}
                  </option>
                ))}
              </select>
            </label>
            {!isCurrent && <span className="muted small">{t('writing.draft.read_only')}</span>}
          </div>
          <textarea
            className="writing-input"
            aria-label={t('writing.draft.text_label')}
            value={shownText}
            readOnly={!isCurrent || running}
            onChange={(e) => edit(e.target.value)}
            onBlur={() => void save()}
          />
          {check && <CheckSummary check={check} onOpen={onOpenCitation} />}
          {exported && (
            <div className="writing-export">
              <OutputFormat prefs={prefs} onChange={onPrefsChange} />
              <label className="row small">
                <input type="checkbox" checked={quotes} onChange={(e) => setQuotes(e.target.checked)} />
                <span>{t('writing.draft.include_quotes')}</span>
              </label>
              <div className="row">
                <button disabled={checking} onClick={copy}>
                  {t('writing.draft.copy_as', { format: t(`writing.format.formats.${prefs.format}`) })}
                </button>
                <button disabled={checking} onClick={() => void saveFile()}>
                  {t('writing.draft.save')}
                </button>
                {checking && <span className="muted small">{t('writing.draft.checking')}</span>}
                {exported.unverified > 0 && <span className="warning-text small">{t('writing.draft.export_unverified', { count: exported.unverified })}</span>}
              </div>
            </div>
          )}
        </div>
      )}
      {draftId && view && versions.length === 0 && !running && <p className="muted">{t('writing.draft.no_versions')}</p>}
    </div>
  )
}

/** The counts and one chip per citation: «clave, p. N», its state, and «fuera de la selección»; a chip opens the PDF. */
function CheckSummary({ check, onOpen }: { check: DraftCheck; onOpen: (c: DraftCitation) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const verified = check.citations.length - check.unverified
  return (
    <div className="writing-report">
      <p role="status">
        {t('writing.draft.count_citations', { count: check.citations.length, verified })}
        {check.unverified > 0 && <span className="warning-text">{` · ${t('writing.draft.count_unverified', { count: check.unverified })}`}</span>}
        {check.outside > 0 && <span className="warning-text">{` · ${t('writing.draft.count_outside', { count: check.outside })}`}</span>}
        {check.uncited > 0 && <span className="warning-text">{` · ${t('writing.draft.count_uncited', { count: check.uncited })}`}</span>}
      </p>
      {check.citations.length > 0 && (
        <div className="draft-chips">
          {check.citations.map((c, i) => {
            const openable = c.state === 'found' || c.state === 'not_found'
            return (
              <button
                key={i}
                type="button"
                className={`cite-chip cite-${c.outside ? 'not_found' : c.state}`}
                title={t('chat.quoted', { quote: c.quote })}
                aria-disabled={!openable || undefined}
                onClick={() => openable && onOpen(c)}
              >
                {citationLabel(c)}
                {c.state !== 'found' && <span className="cite-state"> · {t(`chat.citation.${c.state}`)}</span>}
                {c.outside && <span className="cite-state"> · {t('writing.draft.outside')}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

type PaperSource = 'manual' | 'filtered' | 'mapping'

/** The draft's form: title, purpose, research question, papers, length and model. */
function DraftForm({
  input,
  onChange,
  library,
  visibleIds,
  disabled
}: {
  input: DraftInput
  onChange: (input: DraftInput) => void
  library: WritingLibrary | null
  visibleIds: string[] | null
  disabled: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [thesis, setThesis] = useState<ThesisContext | null>(null)
  const [mappings, setMappings] = useState<MappingSummary[]>([])
  const [source, setSource] = useState<PaperSource>('manual')
  const [mappingId, setMappingId] = useState('')
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    window.research.thesis.get().then(setThesis, () => setThesis(null))
    window.research.mappings.list().then(
      (list) => setMappings(list.filter((m) => !m.problem)),
      () => setMappings([])
    )
  }, [])

  const inLibrary = useMemo(() => new Set(library?.papers.map((p) => p.id) ?? []), [library])
  const chosen = new Set(input.papers)
  const set = (patch: Partial<DraftInput>): void => onChange({ ...input, ...patch })
  const toggle = (id: string, on: boolean): void => set({ papers: on ? [...input.papers, id] : input.papers.filter((p) => p !== id) })

  const applyFiltered = (): void => set({ papers: (visibleIds ?? []).filter((id) => inLibrary.has(id)) })
  const applyMapping = (id: string): void => {
    setMappingId(id)
    if (!id) return
    setError(null)
    window.research.writing.outlineData({ kind: 'mapping', mappingId: id }).then(
      (r) => {
        if (r.ok) set({ papers: r.data.papers.map((p) => p.id) })
        else setError(errorText(t, r.error))
      },
      () => setError(errorText(t, 'unknown'))
    )
  }

  const folded = filter.trim().toLowerCase()
  const matches = (library?.papers ?? []).filter((p) => !folded || p.id.includes(folded) || p.title.toLowerCase().includes(folded)).slice(0, 200)
  return (
    <fieldset className="draft-form" disabled={disabled}>
      <div className="writing-controls">
        <label className="field">
          <span>{t('writing.draft.section_title')}</span>
          <input value={input.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="field">
          <span>{t('writing.draft.question')}</span>
          <select value={input.rq ?? ''} onChange={(e) => set({ rq: e.target.value || null })}>
            <option value="">{t('writing.outline.no_question')}</option>
            {thesis?.research_questions.map((q) => (
              <option key={q.id} value={q.id}>
                {`${q.id}: ${q.text}`}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('writing.draft.length')}</span>
          <select value={input.length} onChange={(e) => set({ length: e.target.value as DraftLength })}>
            {DRAFT_LENGTHS.map((l) => (
              <option key={l} value={l}>
                {t(`writing.draft.lengths.${l}`, { words: DRAFT_WORDS[l] })}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('writing.draft.model')}</span>
          <select value={input.model} onChange={(e) => set({ model: e.target.value as LlmModel })}>
            {LLM_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>{t('writing.draft.purpose')}</span>
        <textarea rows={3} maxLength={4000} placeholder={t('writing.draft.purpose_placeholder')} value={input.purpose} onChange={(e) => set({ purpose: e.target.value })} />
      </label>
      <div className="field">
        <span>{t('writing.draft.papers', { count: input.papers.length })}</span>
        <div className="row" role="radiogroup" aria-label={t('writing.draft.papers_source')}>
          <label className="row">
            <input type="radio" name="draft-source" checked={source === 'manual'} onChange={() => setSource('manual')} />
            <span>{t('writing.draft.sources.manual')}</span>
          </label>
          <label className="row">
            <input
              type="radio"
              name="draft-source"
              checked={source === 'filtered'}
              disabled={!visibleIds}
              onChange={() => {
                setSource('filtered')
                applyFiltered()
              }}
            />
            <span>{visibleIds ? t('writing.outline.scopes.filtered', { count: visibleIds.length }) : t('writing.outline.scopes.filtered_unknown')}</span>
          </label>
          <label className="row">
            <input type="radio" name="draft-source" checked={source === 'mapping'} disabled={mappings.length === 0} onChange={() => setSource('mapping')} />
            <span>{t('writing.outline.scopes.mapping')}</span>
          </label>
          {source === 'mapping' && (
            <select aria-label={t('writing.outline.mapping')} value={mappingId} onChange={(e) => applyMapping(e.target.value)}>
              <option value="">{t('writing.outline.pick_mapping')}</option>
              {mappings.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </select>
          )}
        </div>
        {error && <div className="banner error">{error}</div>}
        {input.papers.length > 0 && (
          <div className="draft-chips">
            {input.papers.map((id) => (
              <button key={id} type="button" className={`cite-chip${inLibrary.has(id) ? '' : ' cite-unknown_paper'}`} title={t('writing.draft.remove_paper')} onClick={() => toggle(id, false)}>
                {id} ×
              </button>
            ))}
            <button type="button" className="link small" onClick={() => set({ papers: [] })}>
              {t('writing.draft.clear_papers')}
            </button>
          </div>
        )}
        {source === 'manual' && (
          <>
            <input type="search" placeholder={t('writing.draft.filter_papers')} aria-label={t('writing.draft.filter_papers')} value={filter} onChange={(e) => setFilter(e.target.value)} />
            <ul className="plain-list draft-papers">
              {matches.map((p) => (
                <li key={p.id}>
                  <label className="row small">
                    <input type="checkbox" checked={chosen.has(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
                    <span>
                      <code>{p.id}</code> {p.title}
                      {p.year !== null && ` (${p.year})`}
                      {!p.hasText && <span className="muted"> · {t('writing.key_state.no_text')}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </fieldset>
  )
}
