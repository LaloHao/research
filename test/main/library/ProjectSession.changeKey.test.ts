import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectSession } from '../../../src/main/library/ProjectSession'
import { ProjectError } from '../../../src/main/project/errors'
import { relationId } from '../../../src/shared/typedRelations'
import { assistantMessage, chatFile, DRAIN_QUOTE, userMessage } from '../../helpers/chats'
import { draftFile } from '../../helpers/drafts'
import { newFacetSuggestion } from '../../helpers/facets'
import { routeFetch } from '../../helpers/fakeFetch'
import { hexId, record } from '../../helpers/mappings'
import { DRAIN_ID, LOGHUB_ID, seedPair } from '../../helpers/pair'
import { typedRelation } from '../../helpers/relations'
import { tmpDir } from '../../helpers/tmp'

const base = { contactEmail: '', citationPauseMs: 0, fetch: routeFetch([]), deviceId: '33333333-3333-3333-3333-333333333333', watch: false, machineName: 'laptop' }
const NEW = 'he2017online'
const REL = typedRelation()
const PAPER_CHAT = '20261011-120000-a1b2'
const LIBRARY_CHAT = '20261011-130000-c3d4'
const LOGHUB_ANSWER = `Loghub collects datasets [[${LOGHUB_ID}|p. 1|"Loghub is a large collection of system log datasets."]].`

/** Drain and Loghub indexed, and every kind of file outside the paper folders that names Drain by its key. */
async function seeded() {
  const s = await ProjectSession.create(await tmpDir(), 'Thesis', base)
  await seedPair(s.store, s.cache, { index: (id) => s.library.indexPaper(id) })
  const { store } = s
  await store.writeRelations({ schema_version: 1, relations: [REL], analyzed: { [DRAIN_ID]: { candidates: [LOGHUB_ID], at: '2026-10-10T00:00:00.000Z' }, [LOGHUB_ID]: { candidates: [DRAIN_ID], at: '2026-10-10T00:00:00.000Z' } } }, null)
  await s.relations.reindex()
  const excerpt = { paper: DRAIN_ID, page: 1, quote: DRAIN_QUOTE }
  await store.writeChat(chatFile([userMessage({ excerpt }), assistantMessage()], { id: PAPER_CHAT, scope: { paper: DRAIN_ID } }), null)
  await store.writeChat(chatFile([userMessage({ text: 'And Loghub?' }), assistantMessage({ text: LOGHUB_ANSWER })], { id: LIBRARY_CHAT }), null)
  await s.chats.reindex()
  await store.writeDraft(draftFile(), null)
  await s.drafts.reindex()
  const mapping = await s.mappings.create('Logs')
  await store.writeMappingFile(mapping, 'records', { schema_version: 1, records: [record({ paper_id: DRAIN_ID }), record({ id: hexId('r', 2), title: 'Loghub', identifiers: {}, paper_id: LOGHUB_ID })] }, null)
  await s.mappings.reindexAll()
  const example = { paper: DRAIN_ID, value: 'public_dataset', quote: DRAIN_QUOTE, page: 1, found: true }
  await store.writeFacetSuggestions({ schema_version: 1, suggestions: [newFacetSuggestion({ examples: [example] })] }, null)
  await s.facets.reindex()
  await s.library.exportBib()
  return { s, mapping }
}

/** Every file outside the paper folders, as text. */
async function projectFiles(s: ProjectSession, mapping: string): Promise<Record<string, string>> {
  const files = ['relations.yaml', 'facet-suggestions.yaml', `chats/${PAPER_CHAT}.md`, `chats/${LIBRARY_CHAT}.md`, `drafts/${draftFile().meta.id}.md`, `mappings/${mapping}/records.yaml`]
  return Object.fromEntries(await Promise.all(files.map(async (f) => [f, await readFile(join(s.store.root, f), 'utf8')] as const)))
}

describe('ProjectSession.changeKey', () => {
  it('renames the paper and every reference to it: relations, chats, drafts, mappings and facet suggestions', async () => {
    const { s, mapping } = await seeded()
    expect(await s.suggestKey(DRAIN_ID)).toEqual({ key: DRAIN_ID, same: true })
    expect(await s.changeKey(DRAIN_ID, NEW)).toBe(NEW)

    expect(s.library.list().map((r) => r.id)).toEqual([NEW, LOGHUB_ID])
    expect((await s.detail(NEW)).paper?.bibtex).toContain(`{${NEW},`)
    expect(await readFile(join(s.store.exportsDir, 'library.bib'), 'utf8')).not.toContain(DRAIN_ID)

    const relations = await s.store.readRelations()
    const rel = relations?.ok ? relations.value : null
    expect(rel?.relations.map((r) => [r.id, r.from, r.to])).toEqual([[relationId(LOGHUB_ID, NEW, 'extends'), LOGHUB_ID, NEW]])
    expect(rel?.analyzed).toEqual({ [NEW]: { candidates: [LOGHUB_ID], at: '2026-10-10T00:00:00.000Z' }, [LOGHUB_ID]: { candidates: [NEW], at: '2026-10-10T00:00:00.000Z' } })
    expect(s.relations.forPaper(NEW).suggested).toHaveLength(1)
    expect(s.map.graph().typed.map((e) => [e.source, e.target])).toEqual([[LOGHUB_ID, NEW]])

    const chat = await s.store.readChat(PAPER_CHAT)
    expect(chat?.ok && chat.value.meta.scope).toEqual({ paper: NEW })
    const [question, answer] = chat?.ok ? chat.value.messages : []
    expect(question.role === 'user' && question.excerpt?.paper).toBe(NEW)
    expect(answer.role === 'assistant' && answer.text).toBe(`Drain parses logs online [[${NEW}|p. 1|"${DRAIN_QUOTE}"]].`)
    expect(s.chats.list({ paper: NEW }).map((c) => c.id)).toEqual([PAPER_CHAT])
    expect(s.chats.list({ paper: NEW })[0].paperState).toBe('library')
    expect((await s.chats.open(PAPER_CHAT)).messages.flatMap((m) => ('citations' in m ? m.citations.map((c) => [c.paper, c.state]) : []))).toEqual([[NEW, 'found']])
    const untouched = await s.store.readChat(LIBRARY_CHAT)
    expect(untouched?.ok && untouched.value.meta.updated_at).toBe('2026-10-11T12:00:00.000Z')

    const draft = await s.store.readDraft(draftFile().meta.id)
    expect(draft?.ok && draft.value.meta.papers).toEqual([NEW])
    expect(draft?.ok && draft.value.texts[0]).toContain(`[[${NEW}|p. 1|`)

    const records = await s.store.readMappingFile(mapping, 'records')
    expect(records?.ok && records.value.records.map((r) => r.paper_id)).toEqual([NEW, LOGHUB_ID])
    expect(await s.mappings.includedPapers(mapping)).toEqual([])
    expect(s.cache.mappingRows(mapping).map((r) => r.paper_id)).toEqual([NEW, LOGHUB_ID])

    const facets = await s.store.readFacetSuggestions()
    expect(facets?.ok && facets.value.suggestions[0].examples.map((e) => e.paper)).toEqual([NEW])

    const all = Object.values(await projectFiles(s, mapping)).join('\n')
    expect(all).not.toContain(DRAIN_ID)
    await s.close()
  })

  it('puts every file back when one kind of reference cannot be rewritten', async () => {
    const { s, mapping } = await seeded()
    const before = await projectFiles(s, mapping)
    vi.spyOn(s.mappings, 'rekeyPaper').mockRejectedValueOnce(new ProjectError('mapping in conflict', 'folder_busy'))
    await expect(s.changeKey(DRAIN_ID, NEW)).rejects.toMatchObject({ code: 'folder_busy' })
    expect(s.store.paperExists(DRAIN_ID)).toBe(true)
    expect(s.library.list().map((r) => r.id)).toEqual([DRAIN_ID, LOGHUB_ID])
    const after = await projectFiles(s, mapping)
    // Rewritten twice, relations, chats and the draft carry a new date; what they say is as it was.
    for (const [file, text] of Object.entries(after)) {
      const stamp = (t: string): string => t.replace(/^\s*updated_at: .*$/gm, '')
      expect([file, stamp(text)]).toEqual([file, stamp(before[file])])
    }
    await s.close()
  })
})
