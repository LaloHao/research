import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { toYaml } from '../../../src/main/project/yamlFile'
import { ProjectRepo } from '../../../src/main/sync/ProjectRepo'
import { editedKeys, planMerge, trashedKeys, type MergePlan } from '../../../src/main/sync/syncMerge'
import type { ConflictChoice } from '../../../src/shared/sync'
import type { TypedRelation } from '../../../src/shared/typedRelations'
import { applyFiles, commitAll, trashOnDisk, twoMachines, type Machines } from '../../helpers/git'
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
