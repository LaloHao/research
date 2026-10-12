import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { sha256 } from '../../../src/main/project/atomicWrite'
import { parseChat, renderChat } from '../../../src/main/project/chatFile'
import { toYaml } from '../../../src/main/project/yamlFile'
import { ProjectRepo } from '../../../src/main/sync/ProjectRepo'
import { editedKeys, planMerge, trashedKeys, type MergePlan } from '../../../src/main/sync/syncMerge'
import type { ConflictChoice } from '../../../src/shared/sync'
import type { TypedRelation } from '../../../src/shared/typedRelations'
import { assistantMessage, CHAT_ID_A, chatFile, userMessage } from '../../helpers/chats'
import { applyFiles, commitAll, trashOnDisk, twoMachines, type Machines } from '../../helpers/git'
import { decision, hexId, protocolBody, protocolFile, record } from '../../helpers/mappings'
import { typedRelation } from '../../helpers/relations'

type Edit = (project: string, repoRoot: string) => Promise<void>

/** Machine A commits and pushes `onA`; machine B commits `onB` and fetches: B plans the merge (B is "ours"). */
async function diverged(files: Record<string, string>, onA: Edit, onB: Edit, opts: { sub?: string; outside?: Record<string, string> } = {}) {
  const m: Machines = await twoMachines(files, opts)
  await onA(m.projectA, m.a)
  commitAll(m, m.a, 'A')
  m.git(m.a, 'push', '--quiet')
  await onB(m.projectB, m.b)
  commitAll(m, m.b, 'B')
  const repo = (await ProjectRepo.open(m.projectB, { env: m.env }))!
  await repo.fetch('origin')
  const ours = (await repo.revParse('HEAD'))!
  const theirs = (await repo.revParse('@{upstream}'))!
  const base = (await repo.mergeBase(ours, theirs))!
  const plan = (choices: Record<string, ConflictChoice> = {}): Promise<MergePlan> =>
    planMerge(repo, { ours, theirs, base, choices: new Map(Object.entries(choices)) })
  const file = async (tree: string, path: string): Promise<string | null> => (await repo.readFileAt(tree, `${repo.prefix}${path}`))?.toString('utf8') ?? null
  return { m, repo, plan, file }
}

const clean = (plan: MergePlan): string => {
  if (plan.kind !== 'clean') throw new Error(`expected a clean merge, got ${JSON.stringify(plan)}`)
  return plan.tree
}

const relationsText = (relations: TypedRelation[]): string => toYaml({ schema_version: 1, relations, analyzed: {} })
const EXTENDS = typedRelation()
const SAME = typedRelation({ type: 'same_problem' })
const USES = typedRelation({ type: 'uses_method_of' })
const DEVICE = '22222222-2222-2222-2222-222222222222'
const cost = (n: number): string => JSON.stringify({ at: `2026-10-0${n}T00:00:00.000Z`, paper_id: 'he2017drain', cost_usd: n })
const trashed = (at: string): string => `schema_version: 1\ntrashed_at: '${at}'\ndevice: ${DEVICE}\n`
const PAPER = 'schema_version: 1\nid: k\ntitle: Kernel paper\n'

describe('planMerge', () => {
  it('merges the decisions and records two machines added to a mapping, with no decision for the user', async () => {
    const dir = 'mappings/20261012-090000-a1b2'
    const d1 = decision()
    const onA = decision({ id: hexId('d', 2), replaces: [d1.id], at: '2026-10-12T10:05:00.000Z' })
    const onB = decision({ id: hexId('d', 3), record: hexId('r', 2), at: '2026-10-12T10:06:00.000Z' })
    const r2 = record({ id: hexId('r', 2), title: 'Another work', identifiers: {}, added_at: '2026-10-12T10:00:00.000Z', updated_at: '2026-10-12T10:00:00.000Z' })
    const yaml = (key: string, list: unknown[]): string => toYaml({ schema_version: 1, [key]: list })
    const { plan, file } = await diverged(
      { [`${dir}/decisions.yaml`]: yaml('decisions', [d1]), [`${dir}/records.yaml`]: yaml('records', [record()]) },
      (p) => applyFiles(p, { [`${dir}/decisions.yaml`]: yaml('decisions', [d1, onA]), [`${dir}/records.yaml`]: yaml('records', [record(), r2]) }),
      (p) => applyFiles(p, { [`${dir}/decisions.yaml`]: yaml('decisions', [d1, onB]), [`${dir}/records.yaml`]: yaml('records', [record({ paper_id: 'he2017drain', updated_at: '2026-10-12T11:00:00.000Z' })]) })
    )
    const tree = clean(await plan())
    expect((parse((await file(tree, `${dir}/decisions.yaml`))!) as { decisions: { id: string }[] }).decisions.map((d) => d.id)).toEqual([d1.id, onA.id, onB.id])
    const records = (parse((await file(tree, `${dir}/records.yaml`))!) as { records: { id: string; paper_id: string | null }[] }).records
    expect(records.map((r) => [r.id, r.paper_id])).toEqual([
      [hexId('r', 1), 'he2017drain'],
      [hexId('r', 2), null]
    ])
  })

  it('makes a protocol both machines changed differently the user’s decision', async () => {
    const path = 'mappings/20261012-090000-a1b2/protocol.yaml'
    const edited = (objective: string): string => toYaml(protocolFile({ updated_at: '2026-10-12T11:00:00.000Z' }, protocolBody({ objective })))
    const { plan, file } = await diverged(
      { [path]: toYaml(protocolFile()) },
      (p) => applyFiles(p, { [path]: edited('From A.') }),
      (p) => applyFiles(p, { [path]: edited('From B.') })
    )
    const pending = await plan()
    expect(pending.kind === 'decisions' && pending.conflicts.map((c) => c.id)).toEqual([`file:${path}`])
    expect((parse((await file(clean(await plan({ [`file:${path}`]: 'theirs' })), path))!) as { protocol: { objective: string } }).protocol.objective).toBe('From A.')
  })

  it('keeps a conversation continued differently on both machines twice, and one deleted here but continued there', async () => {
    const base = renderChat(chatFile())
    const other = '20261011-110000-c3d4'
    const otherBase = renderChat(chatFile(undefined, { id: other }))
    const onA = renderChat(chatFile([...chatFile().messages, userMessage({ at: '2026-10-11T13:00:00.000Z', text: 'From A' })], { updated_on: 'machine-a' }))
    const onB = renderChat(chatFile([...chatFile().messages, userMessage({ at: '2026-10-11T13:30:00.000Z', text: 'From B' })]))
    const continued = renderChat(chatFile([...chatFile().messages, userMessage(), assistantMessage()], { id: other }))
    const { plan, file, repo } = await diverged(
      { [`chats/${CHAT_ID_A}.md`]: base, [`chats/${other}.md`]: otherBase },
      (p) => applyFiles(p, { [`chats/${CHAT_ID_A}.md`]: onA, [`chats/${other}.md`]: continued }),
      (p) => applyFiles(p, { [`chats/${CHAT_ID_A}.md`]: onB, [`chats/${other}.md`]: null })
    )
    const tree = clean(await plan())
    expect(await file(tree, `chats/${CHAT_ID_A}.md`)).toBe(onB)
    expect(await file(tree, `chats/${other}.md`)).toBe(continued)
    const copies = (await repo.lsTree(tree, [`${repo.prefix}chats/`])).map((e) => e.path.slice(repo.prefix.length)).filter((p) => p.startsWith(`chats/${CHAT_ID_A}-`))
    expect(copies).toHaveLength(1)
    expect(await file(tree, copies[0])).toContain('From A')
    expect(await file(tree, copies[0])).toContain('machine: machine-a')
  })

  it('never overwrites another file at the path a copy would take', async () => {
    const onA = renderChat(chatFile([...chatFile().messages, userMessage({ at: '2026-10-11T13:00:00.000Z', text: 'From A' })], { updated_on: 'machine-a' }))
    const onB = renderChat(chatFile([...chatFile().messages, userMessage({ at: '2026-10-11T13:30:00.000Z', text: 'From B' })]))
    const taken = `chats/${CHAT_ID_A}-${sha256(onA).slice(0, 6)}.md`
    const { plan, file } = await diverged(
      { [`chats/${CHAT_ID_A}.md`]: renderChat(chatFile()), [taken]: 'something else\n' },
      (p) => applyFiles(p, { [`chats/${CHAT_ID_A}.md`]: onA }),
      (p) => applyFiles(p, { [`chats/${CHAT_ID_A}.md`]: onB })
    )
    const pending = await plan()
    expect(pending.kind === 'decisions' && pending.conflicts.map((c) => c.id)).toEqual([`file:chats/${CHAT_ID_A}.md`])
    expect(await file(clean(await plan({ [`file:chats/${CHAT_ID_A}.md`]: 'theirs' })), taken)).toBe('something else\n')
  })

  it('merges a conversation only one machine continued, and leaves one it cannot read to the user', async () => {
    const broken = '20261011-110000-c3d4'
    const longer = renderChat(chatFile([...chatFile().messages, userMessage({ at: '2026-10-11T13:00:00.000Z', text: 'More' })]))
    const { plan, file } = await diverged(
      { [`chats/${CHAT_ID_A}.md`]: renderChat(chatFile()), [`chats/${broken}.md`]: renderChat(chatFile(undefined, { id: broken })) },
      (p) => applyFiles(p, { [`chats/${CHAT_ID_A}.md`]: longer, [`chats/${broken}.md`]: 'not a conversation\n' }),
      (p) => applyFiles(p, { [`chats/${CHAT_ID_A}.md`]: renderChat(chatFile(undefined, { title: 'Renamed' })), [`chats/${broken}.md`]: renderChat(chatFile(undefined, { id: broken, archived: true })) })
    )
    const pending = await plan()
    expect(pending.kind === 'decisions' && pending.conflicts.map((c) => c.id)).toEqual([`file:chats/${broken}.md`])
    const tree = clean(await plan({ [`file:chats/${broken}.md`]: 'ours' }))
    expect(await file(tree, `chats/${CHAT_ID_A}.md`)).toBe(renderChat(chatFile([...chatFile().messages, userMessage({ at: '2026-10-11T13:00:00.000Z', text: 'More' })], { title: 'Renamed' })))
  })

  it('merges an answer added on one machine with a rename on the other, field by field, recomputing the cost', async () => {
    const answered = [...chatFile().messages, userMessage({ at: '2026-10-11T13:00:00.000Z', text: 'And then?' }), assistantMessage({ at: '2026-10-11T13:00:05.000Z', costUsd: 0.05, text: 'Then it clusters.' })]
    const { plan, file } = await diverged(
      { [`chats/${CHAT_ID_A}.md`]: renderChat(chatFile()) },
      (p) => applyFiles(p, { [`chats/${CHAT_ID_A}.md`]: renderChat(chatFile(answered, { updated_at: '2026-10-11T13:00:05.000Z', updated_on: 'machine-a' })) }),
      (p) => applyFiles(p, { [`chats/${CHAT_ID_A}.md`]: renderChat(chatFile(undefined, { title: 'Renamed', updated_at: '2026-10-11T12:30:00.000Z' })) })
    )
    const merged = parseChat((await file(clean(await plan()), `chats/${CHAT_ID_A}.md`))!)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(merged.value.messages).toEqual(answered)
    expect(merged.value.meta).toMatchObject({ title: 'Renamed', updated_at: '2026-10-11T13:00:05.000Z', updated_on: 'machine-a', cost_usd: 0.07 })
  })

  it('splits a conversation continued differently on both machines in a project inside a subfolder', async () => {
    const onA = renderChat(chatFile([...chatFile().messages, userMessage({ at: '2026-10-11T13:00:00.000Z', text: 'From A' })], { updated_on: 'machine-a' }))
    const onB = renderChat(chatFile([...chatFile().messages, userMessage({ at: '2026-10-11T13:30:00.000Z', text: 'From B' })]))
    const { plan, file, repo } = await diverged(
      { [`chats/${CHAT_ID_A}.md`]: renderChat(chatFile()) },
      (p) => applyFiles(p, { [`chats/${CHAT_ID_A}.md`]: onA }),
      (p) => applyFiles(p, { [`chats/${CHAT_ID_A}.md`]: onB }),
      { sub: 'research' }
    )
    expect(repo.prefix).toBe('research/')
    const tree = clean(await plan())
    expect(await file(tree, `chats/${CHAT_ID_A}.md`)).toBe(onB)
    const copy = `chats/${CHAT_ID_A}-${sha256(onA).slice(0, 6)}.md`
    expect(await file(tree, copy)).toContain('From A')
    expect(await file(tree, copy)).toContain('machine: machine-a')
    expect(await repo.readFileAt(tree, copy)).toBeNull()
  })

  it('merges changes to different files with no decision', async () => {
    const { plan, file } = await diverged(
      { 'a.md': 'a\n', 'b.md': 'b\n' },
      (p) => applyFiles(p, { 'a.md': 'a from A\n' }),
      (p) => applyFiles(p, { 'b.md': 'b from B\n' })
    )
    const tree = clean(await plan())
    expect(await file(tree, 'a.md')).toBe('a from A\n')
    expect(await file(tree, 'b.md')).toBe('b from B\n')
  })

  it('merges relations.yaml, a cost log, the dismissed candidates, trashed.yaml and the bibliography on its own', async () => {
    const { plan, file } = await diverged(
      {
        'relations.yaml': relationsText([EXTENDS]),
        [`costs/${DEVICE}.jsonl`]: `${cost(1)}\n`,
        'project.yaml': toYaml({ schema_version: 1, name: 'Thesis', snowball: { dismissed: ['W1'] } }),
        'exports/library.bib': '% base\n'
      },
      (p) =>
        applyFiles(p, {
          'relations.yaml': relationsText([EXTENDS, SAME]),
          [`costs/${DEVICE}.jsonl`]: `${cost(1)}\n${cost(2)}\n`,
          'project.yaml': toYaml({ schema_version: 1, name: 'Thesis', snowball: { dismissed: ['W1', 'W2'] } }),
          'exports/library.bib': '% from A\n',
          '.trash/gone2020x/paper.yaml': 'schema_version: 1\nid: gone2020x\ntitle: Gone\n',
          '.trash/gone2020x/trashed.yaml': trashed('2026-10-11T10:00:00.000Z')
        }),
      (p) =>
        applyFiles(p, {
          'relations.yaml': relationsText([EXTENDS, USES]),
          [`costs/${DEVICE}.jsonl`]: `${cost(1)}\n${cost(3)}\n`,
          'project.yaml': toYaml({ schema_version: 1, name: 'Thesis', snowball: { dismissed: ['W1', 'W3'] } }),
          'exports/library.bib': '% from B\n',
          '.trash/gone2020x/paper.yaml': 'schema_version: 1\nid: gone2020x\ntitle: Gone\n',
          '.trash/gone2020x/trashed.yaml': trashed('2026-10-11T12:00:00.000Z')
        })
    )
    const tree = clean(await plan())
    expect((parse((await file(tree, 'relations.yaml'))!) as { relations: TypedRelation[] }).relations.map((r) => r.id)).toEqual([EXTENDS.id, SAME.id, USES.id])
    expect(await file(tree, `costs/${DEVICE}.jsonl`)).toBe(`${cost(1)}\n${cost(3)}\n${cost(2)}\n`)
    expect(parse((await file(tree, 'project.yaml'))!)).toEqual({ schema_version: 1, name: 'Thesis', snowball: { dismissed: ['W1', 'W2', 'W3'] } })
    expect(await file(tree, 'exports/library.bib')).toBe('% from B\n')
    expect(await file(tree, '.trash/gone2020x/trashed.yaml')).toBe(trashed('2026-10-11T12:00:00.000Z'))
  })

  it('asks for a decision on a file edited on both machines, and applies the choice', async () => {
    const { plan, file } = await diverged(
      { 'papers/k/paper.yaml': PAPER, 'papers/k/summary.md': 'base\n' },
      (p) => applyFiles(p, { 'papers/k/summary.md': 'from A\n' }),
      (p) => applyFiles(p, { 'papers/k/summary.md': 'from B\n' })
    )
    const pending = await plan()
    expect(pending).toMatchObject({ kind: 'decisions', conflicts: [{ kind: 'file', id: 'file:papers/k/summary.md', path: 'papers/k/summary.md' }] })
    if (pending.kind !== 'decisions' || pending.conflicts[0].kind !== 'file') throw new Error('expected one file decision')
    expect(pending.conflicts[0].base).not.toBeNull()
    expect(pending.conflicts[0].ours).not.toBeNull()
    expect(pending.conflicts[0].theirs).not.toBeNull()
    expect(await file(clean(await plan({ 'file:papers/k/summary.md': 'ours' })), 'papers/k/summary.md')).toBe('from B\n')
    expect(await file(clean(await plan({ 'file:papers/k/summary.md': 'theirs' })), 'papers/k/summary.md')).toBe('from A\n')
  })

  it('treats a file deleted on one machine and edited on the other as a decision', async () => {
    const { plan, file } = await diverged(
      { 'papers/k/paper.yaml': PAPER, 'papers/k/notes.md': 'notes\n' },
      (p) => applyFiles(p, { 'papers/k/notes.md': null }),
      (p) => applyFiles(p, { 'papers/k/notes.md': 'notes, edited on B\n' })
    )
    const pending = await plan()
    expect(pending).toMatchObject({ kind: 'decisions', conflicts: [{ kind: 'file', id: 'file:papers/k/notes.md', theirs: null }] })
    expect(await file(clean(await plan({ 'file:papers/k/notes.md': 'theirs' })), 'papers/k/notes.md')).toBeNull()
    expect(await file(clean(await plan({ 'file:papers/k/notes.md': 'ours' })), 'papers/k/notes.md')).toBe('notes, edited on B\n')
  })

  it('asks whether to keep a paper the other machine trashed while this one edited it', async () => {
    const { plan, file } = await diverged(
      { 'papers/k/paper.yaml': PAPER, 'papers/k/notes.md': 'my notes\n' },
      (p) => trashOnDisk(p, 'k'),
      (p) => applyFiles(p, { 'papers/k/notes.md': 'my notes\nedited on B\n' })
    )
    expect(await plan()).toEqual({ kind: 'decisions', conflicts: [{ kind: 'paper', id: 'paper:k', key: 'k', trashedBy: 'theirs' }] })

    // «Conservar el paper»: the library folder as this machine has it; the trash entry goes.
    const kept = clean(await plan({ 'paper:k': 'ours' }))
    expect(await file(kept, 'papers/k/notes.md')).toBe('my notes\nedited on B\n')
    expect(await file(kept, 'papers/k/paper.yaml')).toBe(PAPER)
    expect(await file(kept, '.trash/k/paper.yaml')).toBeNull()
    expect(await file(kept, '.trash/k/trashed.yaml')).toBeNull()

    // «Aceptar que se quitó»: the paper stays in the trash, with the edit git carried into it.
    const removed = clean(await plan({ 'paper:k': 'theirs' }))
    expect(await file(removed, 'papers/k/paper.yaml')).toBeNull()
    expect(await file(removed, '.trash/k/notes.md')).toBe('my notes\nedited on B\n')
    expect(await file(removed, '.trash/k/trashed.yaml')).not.toBeNull()
  })

  it('keeps in the trash a file the editing machine added to a paper the other machine trashed', async () => {
    const { plan, file } = await diverged(
      { 'papers/k/paper.yaml': PAPER, 'papers/k/notes.md': 'my notes\n' },
      (p) => trashOnDisk(p, 'k'),
      (p) => applyFiles(p, { 'papers/k/summary.md': 'new on B\n' })
    )
    expect(await plan()).toEqual({ kind: 'decisions', conflicts: [{ kind: 'paper', id: 'paper:k', key: 'k', trashedBy: 'theirs' }] })
    const kept = clean(await plan({ 'paper:k': 'ours' }))
    expect(await file(kept, 'papers/k/summary.md')).toBe('new on B\n')
    expect(await file(kept, '.trash/k/summary.md')).toBeNull()
    const removed = clean(await plan({ 'paper:k': 'theirs' }))
    expect(await file(removed, '.trash/k/summary.md')).toBe('new on B\n')
    expect(await file(removed, 'papers/k/summary.md')).toBeNull()
    expect(await file(removed, 'papers/k/paper.yaml')).toBeNull()
  })

  it('asks the same way when this machine trashed the paper the other one edited', async () => {
    const { plan, file } = await diverged(
      { 'papers/k/paper.yaml': PAPER, 'papers/k/notes.md': 'my notes\n' },
      (p) => applyFiles(p, { 'papers/k/notes.md': 'my notes\nedited on A\n' }),
      (p) => trashOnDisk(p, 'k')
    )
    expect(await plan()).toEqual({ kind: 'decisions', conflicts: [{ kind: 'paper', id: 'paper:k', key: 'k', trashedBy: 'ours' }] })
    const kept = clean(await plan({ 'paper:k': 'theirs' }))
    expect(await file(kept, 'papers/k/notes.md')).toBe('my notes\nedited on A\n')
    expect(await file(kept, '.trash/k/trashed.yaml')).toBeNull()
    const removed = clean(await plan({ 'paper:k': 'ours' }))
    expect(await file(removed, 'papers/k/paper.yaml')).toBeNull()
    expect(await file(removed, '.trash/k/trashed.yaml')).not.toBeNull()
  })

  it('stops on a conflict outside the project folder', async () => {
    const { plan } = await diverged(
      { 'project.yaml': 'x\n' },
      (_p, root) => applyFiles(root, { 'thesis.tex': 'from A\n' }),
      (p, root) => applyFiles(root, { 'thesis.tex': 'from B\n' }).then(() => applyFiles(p, { 'notes.md': 'B\n' })),
      { sub: 'research', outside: { 'thesis.tex': 'base\n' } }
    )
    expect(await plan()).toEqual({ kind: 'outside', paths: ['thesis.tex'] })
  })
})

describe('planMerge with the shapes git gives a merge', () => {
  const paths = async (repo: ProjectRepo, tree: string, dir = '.'): Promise<string[]> => (await repo.lsTree(tree, [dir])).map((e) => e.path)

  it.each(['A', 'B'])('keeps a file that clashed with a folder the other machine added (file on %s), under a readable name', async (fileOn) => {
    const asFile = (p: string) => applyFiles(p, { 'papers/k/figs': 'figure list\n' })
    const asFolder = (p: string) => applyFiles(p, { 'papers/k/figs/a.md': 'figure a\n' })
    const { plan, file, repo } = await diverged({ 'papers/k/paper.yaml': PAPER }, fileOn === 'A' ? asFile : asFolder, fileOn === 'A' ? asFolder : asFile)
    const tree = clean(await plan())
    expect(await file(tree, 'papers/k/figs/a.md')).toBe('figure a\n')
    expect(await file(tree, 'papers/k/figs.conflict')).toBe('figure list\n')
    expect((await paths(repo, tree)).filter((p) => p.includes('~'))).toEqual([])
  })

  it('keeps a file added under a folder the other machine renamed, where git put it', async () => {
    const { plan, file, repo } = await diverged(
      { 'project.yaml': 'x\n', 'notes/a.md': 'a\n', 'notes/c.md': 'c\n' },
      async (p) => rename(join(p, 'notes'), join(p, 'drafts')),
      (p) => applyFiles(p, { 'notes/b.md': 'b from B\n' })
    )
    const tree = clean(await plan())
    expect(await file(tree, 'drafts/b.md')).toBe('b from B\n')
    expect(await paths(repo, tree)).toEqual(['drafts/a.md', 'drafts/b.md', 'drafts/c.md', 'project.yaml'])
  })

  it('asks about a binary file edited on both machines and keeps the chosen bytes', async () => {
    const pdf = (who: string): string => `%PDF-1.4\n\0\u0001\u0002 ${who}\n`
    const { plan, file } = await diverged(
      { 'papers/k/paper.yaml': PAPER, 'papers/k/paper.pdf': pdf('base') },
      (p) => applyFiles(p, { 'papers/k/paper.pdf': pdf('A') }),
      (p) => applyFiles(p, { 'papers/k/paper.pdf': pdf('B') })
    )
    expect(await plan()).toMatchObject({ kind: 'decisions', conflicts: [{ kind: 'file', id: 'file:papers/k/paper.pdf' }] })
    expect(await file(clean(await plan({ 'file:papers/k/paper.pdf': 'ours' })), 'papers/k/paper.pdf')).toBe(pdf('B'))
    expect(await file(clean(await plan({ 'file:papers/k/paper.pdf': 'theirs' })), 'papers/k/paper.pdf')).toBe(pdf('A'))
  })

  it('decides with the paper a conflict git carried through the move into the trash', async () => {
    const { plan, file, repo } = await diverged(
      { 'papers/k/paper.yaml': PAPER, 'papers/k/notes.md': 'line 1\nline 2\nline 3\n' },
      (p) => applyFiles(p, { 'papers/k/notes.md': 'line 1\nline 2 from A\nline 3\n' }).then(() => trashOnDisk(p, 'k')),
      (p) => applyFiles(p, { 'papers/k/notes.md': 'line 1\nline 2 from B\nline 3\n' })
    )
    expect(await plan()).toEqual({ kind: 'decisions', conflicts: [{ kind: 'paper', id: 'paper:k', key: 'k', trashedBy: 'theirs' }] })
    const kept = clean(await plan({ 'paper:k': 'ours' }))
    expect(await file(kept, 'papers/k/notes.md')).toBe('line 1\nline 2 from B\nline 3\n')
    expect(await paths(repo, kept, '.trash')).toEqual([])
    const removed = clean(await plan({ 'paper:k': 'theirs' }))
    expect(await file(removed, '.trash/k/notes.md')).toBe('line 1\nline 2 from A\nline 3\n')
    expect(await paths(repo, removed, 'papers')).toEqual([])
  })

  it('decides with the paper when git could not pair the moved file (rewritten, then trashed)', async () => {
    const { plan, file, repo } = await diverged(
      { 'papers/k/paper.yaml': PAPER, 'papers/k/notes.md': 'old notes\n' },
      (p) => applyFiles(p, { 'papers/k/notes.md': 'completely different text written on A\n' }).then(() => trashOnDisk(p, 'k')),
      (p) => applyFiles(p, { 'papers/k/notes.md': 'old notes\nand more from B\n' })
    )
    expect(await plan()).toEqual({ kind: 'decisions', conflicts: [{ kind: 'paper', id: 'paper:k', key: 'k', trashedBy: 'theirs' }] })
    expect(await file(clean(await plan({ 'paper:k': 'ours' })), 'papers/k/notes.md')).toBe('old notes\nand more from B\n')
    const removed = clean(await plan({ 'paper:k': 'theirs' }))
    expect(await file(removed, '.trash/k/notes.md')).toBe('completely different text written on A\n')
    expect(await paths(repo, removed, 'papers')).toEqual([])
  })

  it('merges a paper trashed on both machines with no decision, keeping the latest removal', async () => {
    const { plan, file } = await diverged(
      { 'papers/k/paper.yaml': PAPER, 'papers/k/notes.md': 'notes\n' },
      (p) => trashOnDisk(p, 'k', '2026-10-11T10:00:00.000Z'),
      (p) => trashOnDisk(p, 'k', '2026-10-11T12:00:00.000Z')
    )
    const tree = clean(await plan())
    expect(await file(tree, 'papers/k/paper.yaml')).toBeNull()
    expect(await file(tree, '.trash/k/notes.md')).toBe('notes\n')
    expect(await file(tree, '.trash/k/trashed.yaml')).toBe(trashed('2026-10-11T12:00:00.000Z'))
  })

  it('moves into the trash a nested file the other machine added that git left in the library', async () => {
    const { plan, file, repo } = await diverged(
      { 'papers/k/paper.yaml': PAPER, 'papers/k/notes.md': 'notes\n' },
      (p) => trashOnDisk(p, 'k'),
      (p) => applyFiles(p, { 'papers/k/sub/new.md': 'nested on B\n' })
    )
    expect(await plan()).toMatchObject({ kind: 'decisions', conflicts: [{ kind: 'paper', id: 'paper:k' }] })
    expect(await file(clean(await plan({ 'paper:k': 'ours' })), 'papers/k/sub/new.md')).toBe('nested on B\n')
    const removed = clean(await plan({ 'paper:k': 'theirs' }))
    expect(await paths(repo, removed, 'papers')).toEqual([])
    expect(await file(removed, '.trash/k/sub/new.md')).toBe('nested on B\n')
    expect(await file(removed, '.trash/k/notes.md')).toBe('notes\n')
  })
})

describe('trashed and edited papers', () => {
  it('finds papers moved to the trash, and papers edited that kept their paper.yaml', () => {
    const changes = [
      { status: 'D', path: 'research/papers/k/paper.yaml' },
      { status: 'D', path: 'research/papers/k/notes.md' },
      { status: 'A', path: 'research/.trash/k/paper.yaml' },
      { status: 'A', path: 'research/.trash/k/trashed.yaml' },
      { status: 'M', path: 'research/papers/j/notes.md' },
      { status: 'D', path: 'research/papers/gone/paper.yaml' },
      { status: 'M', path: 'papers/outside/notes.md' }
    ]
    expect([...trashedKeys(changes, 'research/')]).toEqual(['k'])
    expect([...editedKeys(changes, 'research/')]).toEqual(['j'])
  })
})
