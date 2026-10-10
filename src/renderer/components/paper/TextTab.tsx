import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorText } from '../../lib/errorText'
import { findMatches, joinTextItems, reflowPage, repeatedLines, type Block, type TextMatch } from '../../lib/reflow'
import { pdfjs } from './pdfjs'

type DocState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; doc: PDFDocumentProxy; repeated: Set<string> }

type PageState = { page: number; status: 'ready'; text: string } | { page: number; status: 'error'; message: string }

interface SearchResult extends TextMatch {
  page: number
}

type SearchState = { status: 'running'; query: string; page: number } | { status: 'done'; query: string; results: SearchResult[] } | { status: 'error'; message: string }

/** Pages sampled (from the start) to find running headers and footers. */
const SAMPLE_PAGES = 10

/** Running header/footer keys per PDF (paper id + pdf.js fingerprint), so reopening the tab skips the sampling. */
const repeatedCache = new Map<string, Set<string>>()

const NO_RESULTS: SearchResult[] = []

async function readPage(doc: PDFDocumentProxy, n: number): Promise<string> {
  const content = await (await doc.getPage(n)).getTextContent()
  return joinTextItems(content.items as Array<{ str?: string; hasEOL?: boolean }>)
}

/** A block's text, with the search matches that fall in it wrapped in <mark> (rendered by React, never patched into the DOM). */
function BlockText({
  text,
  matches,
  activeIndex,
  activeRef
}: {
  text: string
  matches: { start: number; end: number; index: number }[]
  activeIndex: number
  activeRef: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const parts: React.ReactNode[] = []
  let at = 0
  for (const m of matches) {
    if (m.start > at) parts.push(text.slice(at, m.start))
    const active = m.index === activeIndex
    parts.push(
      <mark key={m.index} className={active ? 'active' : undefined} ref={active ? activeRef : undefined}>
        {text.slice(m.start, m.end)}
      </mark>
    )
    at = m.end
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

/**
 * The PDF's extracted text, page by page, reflowed for reading (see {@link reflowPage}): joined
 * hyphenated words and paragraph lines, detected headings, and running headers/footers dimmed.
 * Pages are read from the PDF on demand; a search reads them all and lists every match.
 */
export function TextTab({ id }: { id: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [doc, setDoc] = useState<DocState>({ status: 'loading' })
  const [page, setPage] = useState(1)
  const [pageState, setPageState] = useState<PageState | null>(null)
  const [jump, setJump] = useState('1')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<SearchState | null>(null)
  const [active, setActive] = useState(0)
  const jumpId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLElement | null>(null)
  const searchSeq = useRef(0)
  const pageCache = useRef(new Map<number, Promise<string>>())

  useEffect(() => {
    let alive = true
    let loaded: PDFDocumentProxy | null = null
    let task: ReturnType<typeof pdfjs.getDocument> | null = null
    pageCache.current = new Map()
    setDoc({ status: 'loading' })
    const fail = (code: string): void => {
      if (alive) setDoc({ status: 'error', message: errorText(t, code) })
    }
    window.research.library.readPdf(id).then(async (result) => {
      if (!alive) return
      if (!result.ok) return fail(result.error)
      if (!result.data) return setDoc({ status: 'missing' })
      try {
        task = pdfjs.getDocument({ data: result.data.slice() })
        const opened = await task.promise
        loaded = opened
        if (!alive) return void opened.destroy()
        const key = `${id}:${opened.fingerprints[0]}`
        let repeated = repeatedCache.get(key)
        if (!repeated) {
          // A page that fails to read is left out of the sample (and read again when shown).
          const sample = await Promise.allSettled(Array.from({ length: Math.min(SAMPLE_PAGES, opened.numPages) }, (_, i) => readPage(opened, i + 1)))
          if (!alive) return
          const read: string[] = []
          sample.forEach((r, i) => {
            if (r.status !== 'fulfilled') return
            read.push(r.value)
            pageCache.current.set(i + 1, Promise.resolve(r.value))
          })
          repeated = repeatedLines(read)
          repeatedCache.set(key, repeated)
        }
        if (alive) setDoc({ status: 'ready', doc: opened, repeated })
      } catch {
        fail('unreadable_pdf')
      }
    }, () => fail('unknown'))
    return () => {
      alive = false
      searchSeq.current += 1
      if (loaded) void loaded.destroy()
      else if (task) void task.destroy()
    }
  }, [id, t])

  const ready = doc.status === 'ready' ? doc : null
  const total = ready?.doc.numPages ?? 0

  /** A page's raw text, read once per document. */
  const loadPage = useCallback(
    (n: number): Promise<string> => {
      if (!ready) return Promise.reject(new Error('not ready'))
      let text = pageCache.current.get(n)
      if (!text) {
        text = readPage(ready.doc, n)
        pageCache.current.set(n, text)
        // A failed read is retried next time instead of being cached.
        text.catch(() => pageCache.current.delete(n))
      }
      return text
    },
    [ready]
  )

  // Ignores the reply for a page that is no longer the current one.
  useEffect(() => {
    if (!ready) return
    let alive = true
    loadPage(page).then(
      (text) => {
        if (alive) setPageState({ page, status: 'ready', text })
      },
      () => {
        if (alive) setPageState({ page, status: 'error', message: errorText(t, 'unreadable_pdf') })
      }
    )
    return () => {
      alive = false
    }
  }, [ready, page, loadPage, t])

  useEffect(() => {
    setJump(String(page))
    rootRef.current?.scrollIntoView({ block: 'start' })
  }, [page])

  const blocks: Block[] = useMemo(
    () => (ready && pageState?.page === page && pageState.status === 'ready' ? reflowPage(pageState.text, ready.repeated) : []),
    [ready, page, pageState]
  )

  const results = search?.status === 'done' ? search.results : NO_RESULTS
  const pageMatches = useMemo(() => {
    const byBlock = new Map<number, { start: number; end: number; index: number }[]>()
    results.forEach((r, index) => {
      if (r.page !== page) return
      const list = byBlock.get(r.block) ?? []
      list.push({ start: r.start, end: r.end, index })
      byBlock.set(r.block, list)
    })
    return byBlock
  }, [results, page])

  // Also on `pageMatches`, so a new search whose first match is on the current page still scrolls to it.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center' })
  }, [active, blocks, pageMatches])

  const goTo = useCallback((n: number) => setPage(Math.min(Math.max(1, n), Math.max(1, total))), [total])

  const runSearch = useCallback(
    async (q: string) => {
      const seq = ++searchSeq.current
      if (!ready || !q.trim()) return setSearch(null)
      try {
        const found: SearchResult[] = []
        for (let n = 1; n <= ready.doc.numPages; n++) {
          setSearch({ status: 'running', query: q, page: n })
          const text = await loadPage(n)
          if (seq !== searchSeq.current) return
          const pageBlocks = reflowPage(text, ready.repeated)
          for (const m of findMatches(pageBlocks.map((b) => b.text), q)) found.push({ ...m, page: n })
        }
        if (seq !== searchSeq.current) return
        setSearch({ status: 'done', query: q, results: found })
        setActive(0)
        if (found.length) setPage(found[0].page)
      } catch {
        if (seq === searchSeq.current) setSearch({ status: 'error', message: errorText(t, 'unreadable_pdf') })
      }
    },
    [ready, loadPage, t]
  )

  const step = useCallback(
    (delta: number) => {
      if (!results.length) return
      const next = (active + delta + results.length) % results.length
      setActive(next)
      setPage(results[next].page)
    },
    [results, active]
  )

  if (doc.status === 'loading') return <div className="center muted">{t('paper.text.loading')}</div>
  if (doc.status === 'missing') return <div className="center muted">{t('paper.no_pdf')}</div>
  if (doc.status === 'error') return <div className="center error">{t('paper.text.error', { message: doc.message })}</div>

  return (
    <div className="text-tab" ref={rootRef}>
      <div className="text-toolbar">
        <div className="row">
          <button className="small" disabled={page <= 1} onClick={() => goTo(page - 1)}>
            {t('paper.text.previous')}
          </button>
          <span>{t('paper.text.page', { page, total })}</span>
          <button className="small" disabled={page >= total} onClick={() => goTo(page + 1)}>
            {t('paper.text.next')}
          </button>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              const n = Number.parseInt(jump, 10)
              if (Number.isFinite(n)) goTo(n)
              else setJump(String(page))
            }}
          >
            <label className="muted" htmlFor={jumpId}>
              {t('paper.text.go_to')}
            </label>
            <input id={jumpId} type="number" min={1} max={total} value={jump} onChange={(e) => setJump(e.target.value)} />
          </form>
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            void runSearch(query)
          }}
        >
          <input
            type="search"
            placeholder={t('paper.text.search_placeholder')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              // Editing the query drops the results (and their highlights) until it is searched again.
              if (search) void runSearch('')
            }}
          />
          <button className="small" type="submit">
            {t('paper.text.search')}
          </button>
          {search?.status === 'running' && <span className="muted">{t('paper.text.searching', { page: search.page, total })}</span>}
          {search?.status === 'error' && <span className="error">{t('paper.text.error', { message: search.message })}</span>}
          {search?.status === 'done' &&
            (results.length ? (
              <>
                <span className="muted">
                  {t('paper.text.results', { count: results.length })} · {t('paper.text.result_position', { current: active + 1, count: results.length })}
                </span>
                <button className="small" type="button" onClick={() => step(-1)} title={t('paper.text.previous_result')} aria-label={t('paper.text.previous_result')}>
                  ↑
                </button>
                <button className="small" type="button" onClick={() => step(1)} title={t('paper.text.next_result')} aria-label={t('paper.text.next_result')}>
                  ↓
                </button>
              </>
            ) : (
              <span className="muted">{t('paper.text.no_results')}</span>
            ))}
        </form>
      </div>
      <div className="text-view">
        {pageState?.page === page && pageState.status === 'error' && <p className="error">{t('paper.text.error', { message: pageState.message })}</p>}
        {pageState?.page === page && pageState.status === 'ready' && blocks.length === 0 && <p className="muted">{t('paper.text.empty_page')}</p>}
        {blocks.map((block, i) => {
          const content = <BlockText text={block.text} matches={pageMatches.get(i) ?? []} activeIndex={active} activeRef={activeRef} />
          if (block.kind === 'heading') return <h3 key={i}>{content}</h3>
          if (block.kind === 'margin') return <p key={i} className="text-margin">{content}</p>
          return <p key={i}>{content}</p>
        })}
      </div>
    </div>
  )
}
