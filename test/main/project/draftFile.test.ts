import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parseDraft, renderDraft } from '../../../src/main/project/draftFile'
import { ConflictError } from '../../../src/main/project/errors'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import type { DraftFile } from '../../../src/shared/writing/draft'
import { DRAFT_ID_A, draftFile, draftVersion } from '../../helpers/drafts'
import { tmpDir } from '../../helpers/tmp'

const read = (text: string): DraftFile => {
  const r = parseDraft(text)
  if (!r.ok) throw new Error(r.problem.message)
  return r.value
}

describe('draft files', () => {
  it('writes the frontmatter and one «## Versión N» section per version, and reads them back', () => {
    const file = draftFile(['First text.', 'Second text,\n\nwith two paragraphs.'])
    const text = renderDraft(file)
    expect(text).toContain('## Versión 1\n\nFirst text.\n\n## Versión 2\n\nSecond text,')
    expect(text).toContain('cost_usd: 0.2')
    expect(read(text)).toEqual(file)
  })

  it('round-trips texts with lines that look like a version heading or a git conflict marker', () => {
    const tricky = ['## Versión 2', '\\## Versión 3', '<<<<<<< HEAD', '=======', '>>>>>>> other', '## Versión x stays'].join('\n')
    const text = renderDraft(draftFile([tricky, 'ok']))
    expect(text).not.toMatch(/^<{7} /m)
    expect(read(text).texts).toEqual([tricky, 'ok'])
  })

  it('keeps a draft with no version yet, and recomputes the cost from the versions', () => {
    const empty = draftFile([], {}, [])
    expect(read(renderDraft(empty))).toEqual(empty)
    const lying = draftFile(['a'], { cost_usd: 99 }, [draftVersion({ cost_usd: 0.123456 })])
    expect(read(renderDraft(lying)).meta).toMatchObject({ cost_usd: 0.1235, versions: [{ cost_usd: 0.1235 }] })
  })

  it('reads a hand-edited file: an extra section gets an entry, an entry without a section is dropped, unknown keys stay', () => {
    const text = renderDraft(draftFile(['one'])).replace('schema_version: 1', 'schema_version: 1\nfrom_later: 1') + '\n## Versión 2\n\ntwo\n'
    const file = read(text)
    expect(file.texts).toEqual(['one', 'two'])
    expect(file.meta.versions[1]).toEqual({ at: file.meta.updated_at, model: 'unknown', cost_usd: 0, stopped: false })
    expect(file.meta).toMatchObject({ from_later: 1 })
    const fewer = renderDraft(draftFile(['one', 'two'])).replace(/\n## Versión 2[\s\S]*$/, '\n')
    expect(read(fewer)).toMatchObject({ texts: ['one'], meta: { versions: [{}], cost_usd: 0.1 } })
    expect(read(renderDraft(file))).toEqual(file)
  })

  it('refuses an invalid frontmatter or conflict markers', () => {
    expect(parseDraft('no frontmatter').ok).toBe(false)
    expect(parseDraft(renderDraft(draftFile()).replace('model: sonnet', 'model: gpt')).ok).toBe(false)
    expect(parseDraft(`<<<<<<< HEAD\n${renderDraft(draftFile())}`).ok).toBe(false)
  })

  it('ProjectStore writes, lists, reads and deletes drafts, hash-checked', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    expect(await store.listDraftIds()).toEqual([])
    expect(await store.readDraft(DRAFT_ID_A)).toBeNull()
    const hash = await store.writeDraft(draftFile(), null)
    await expect(store.writeDraft(draftFile(), null)).rejects.toBeInstanceOf(ConflictError)
    expect(await store.listDraftIds()).toEqual([DRAFT_ID_A])
    expect(await store.readDraft(DRAFT_ID_A)).toMatchObject({ ok: true, hash, value: draftFile() })
    await expect(store.deleteDraft(DRAFT_ID_A, 'stale')).rejects.toBeInstanceOf(ConflictError)
    await store.deleteDraft(DRAFT_ID_A, hash)
    expect(await store.listDraftIds()).toEqual([])
    expect(() => store.draftPath('../x')).toThrow()
  })

  it('reads a file whose frontmatter id is not its own as invalid, and never overwrites one with conflict markers', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    const other = '20261022-130000-ffff'
    await store.writeDraft(draftFile(undefined, { id: other }), null)
    const path = store.draftPath(other)
    await writeFile(store.draftPath(DRAFT_ID_A), await readFile(path, 'utf8'))
    expect(await store.readDraft(DRAFT_ID_A)).toMatchObject({ ok: false, problem: { kind: 'invalid_schema' } })
    const conflicted = `<<<<<<< ours\n${await readFile(path, 'utf8')}`
    await writeFile(path, conflicted)
    const read = (await store.readDraft(other))!
    await expect(store.writeDraft(draftFile(undefined, { id: other }), read.hash)).rejects.toBeInstanceOf(ConflictError)
  })
})
