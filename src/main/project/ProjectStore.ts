import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PaperSchema, ProjectConfigSchema, type Paper, type ProjectConfig } from '../../shared/schemas'
import { CHAT_ID, ChatMetaSchema, PAPER_KEY, type ChatFile } from '../../shared/chat'
import { MAPPING_ID } from '../../shared/mapping'
import { parse } from 'yaml'
import { SnowballSchema, type Snowball } from '../../shared/relations'
import {
  ExtractionFileSchema,
  LlmConfigShape,
  SummaryFileSchema,
  ThesisContextSchema,
  type CostEntry,
  type ExtractionFile,
  type SummaryFile,
  type ThesisContext
} from '../../shared/summary'
import { TrashedFileSchema, type TrashedFile } from '../../shared/trash'
import { RelationsFileSchema, type RelationsFile } from '../../shared/typedRelations'
import { FacetSuggestionsFileSchema, type FacetSuggestionsFile } from '../../shared/facetSuggestions'
import { atomicWrite, MOVE_RETRYABLE, moveDir, sha256 } from './atomicWrite'
import { renderLibraryBib } from '../export/BibExporter'
import { CHATS_DIR, chatFileName, checkMessages, isChatFileName, parseChat, renderChat, totalCost } from './chatFile'
import { ConflictError, ProjectError, type ReadResult } from './errors'
import { FACET_SUGGESTIONS_FILE, sortSuggestions } from './facetSuggestionsFile'
import { gitattributesLines, gitignoreLines, withManagedBlock } from './gitFiles'
import { MAPPING_FILE_NAMES, MAPPING_SCHEMAS, MAPPINGS_DIR, sortedMappingFile, type MappingFileKind, type MappingFiles } from './mappingFiles'
import { RELATIONS_FILE, resolveConflictText, sortRelations } from './relationsFile'
import { siblingName, TRASH_DIR, TRASHED_FILE } from './trashPaths'
import { WriteGate } from './writeGate'
import { hasConflictMarkers, parseFrontmatterFile, parseYamlFile, toFrontmatter, toYaml } from './yamlFile'

export const PROJECT_FILE = 'project.yaml'

const PAPER_ID = PAPER_KEY
const DEVICE_ID = /^[A-Za-z0-9-]+$/
/** A file directly inside a paper folder: no path separators, no dot files. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface TrashedPaper {
  id: string
  /** null when the folder has no paper.yaml (it cannot be restored). */
  paper: ReadResult<Paper> | null
  /** null when trashed.yaml is missing or unreadable. */
  trashed: TrashedFile | null
}

/** Blocks of project.yaml read leniently: an invalid one is replaced by defaults in memory but never on disk by accident. */
const LENIENT_BLOCKS = { llm: LlmConfigShape, thesis: ThesisContextSchema, snowball: SnowballSchema } as const
type LenientBlock = keyof typeof LENIENT_BLOCKS
type InvalidBlocks = Partial<Record<LenientBlock, unknown>>

/** The only writer of the project folder (exports/ and .cache/ aside). */
export class ProjectStore {
  /**
   * Every public method that writes into the project folder; each runs under `gate.shared`, so the git sync (which takes
   * the gate exclusively) never commits a half-done write. None of them calls another one of them: that would wait
   * behind a queued sync forever. A new write method must be added here. (`.cache/` is never committed, so
   * `removeCachedPdf` stays out.)
   */
  static readonly GATED_WRITES = [
    'writePaper',
    'writeNotes',
    'writePdf',
    'writeContent',
    'writeSummary',
    'writeExtraction',
    'writeRelations',
    'resolveRelationsConflict',
    'writeFacetSuggestions',
    'writeMappingFile',
    'writeChat',
    'deleteChat',
    'updateConfig',
    'trashPaper',
    'restorePaper',
    'adoptTrashedFile',
    'keepPaperFileAs',
    'finishMerge',
    'deleteTrashed',
    'appendCost',
    'writeBib'
  ] as const

  static {
    for (const name of ProjectStore.GATED_WRITES) {
      const write = ProjectStore.prototype[name] as (this: ProjectStore, ...args: unknown[]) => Promise<unknown>
      ProjectStore.prototype[name] = function (this: ProjectStore, ...args: unknown[]) {
        return this.gate.shared(() => write.apply(this, args))
      } as never
    }
  }

  private readonly gate = new WriteGate()

  private constructor(
    readonly root: string,
    private cfg: ProjectConfig,
    private cfgHash: string,
    /** The raw on-disk value of each lenient block that failed strict validation, written back as is. */
    private invalidBlocks: InvalidBlocks = {}
  ) {}

  static async create(root: string, name: string): Promise<ProjectStore> {
    if (existsSync(join(root, PROJECT_FILE))) throw new ProjectError(`A project already exists in ${root}`, 'project_exists')
    const cfg = ProjectConfigSchema.parse({ schema_version: 1, name })
    const text = toYaml(cfg)
    await atomicWrite(join(root, PROJECT_FILE), text)
    await mkdir(join(root, 'papers'), { recursive: true })
    const store = new ProjectStore(root, cfg, sha256(text))
    await store.syncIgnoreFiles()
    return store
  }

  static async open(root: string): Promise<ProjectStore> {
    const { cfg, hash, invalid } = await readConfig(root)
    const store = new ProjectStore(root, cfg, hash, invalid)
    // A project made by an earlier version gets the current ignore rules (e.g. PDFs in the trash).
    await store.syncIgnoreFiles()
    await removeMovingLeftovers(root)
    return store
  }

  get config(): ProjectConfig {
    return this.cfg
  }

  /** Runs `fn` with no write in flight, holding every write until it ends (the git sync's local steps). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.gate.exclusive(fn)
  }

  async updateConfig(
    patch: Partial<Pick<ProjectConfig, 'name' | 'content_language' | 'pdfs' | 'llm' | 'extraction_form'>> & {
      thesis?: ThesisContext
      snowball?: Snowball
    }
  ): Promise<ProjectConfig> {
    const next = ProjectConfigSchema.parse({ ...this.cfg, ...patch })
    // An invalid llm/thesis block stays as the user wrote it unless this write replaces that block on purpose.
    const invalid = Object.fromEntries(Object.entries(this.invalidBlocks).filter(([k]) => !(k in patch))) as InvalidBlocks
    const onDisk: Record<string, unknown> = { ...next, ...invalid }
    this.cfgHash = await this.writeChecked(join(this.root, PROJECT_FILE), toYaml(onDisk), this.cfgHash)
    this.cfg = next
    this.invalidBlocks = invalid
    await this.syncIgnoreFiles()
    return next
  }

  /** Picks up an external edit of project.yaml (e.g. after a git pull). Returns false when the file is what we last wrote or read. */
  async reloadConfig(): Promise<boolean> {
    const { cfg, hash, invalid } = await readConfig(this.root)
    const changed = hash !== this.cfgHash
    this.cfg = cfg
    this.cfgHash = hash
    this.invalidBlocks = invalid
    return changed
  }

  paperDir(id: string): string {
    return join(this.root, 'papers', id)
  }

  get cacheDir(): string {
    return join(this.root, '.cache')
  }

  get exportsDir(): string {
    return join(this.root, 'exports')
  }

  paperExists(id: string): boolean {
    return existsSync(join(this.paperDir(id), 'paper.yaml'))
  }

  async listPaperIds(): Promise<string[]> {
    const dir = join(this.root, 'papers')
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && existsSync(join(dir, e.name, 'paper.yaml')))
      .map((e) => e.name)
      .sort()
  }

  async readPaper(id: string): Promise<ReadResult<Paper>> {
    const text = await readFile(join(this.paperDir(id), 'paper.yaml'), 'utf8')
    return checkPaperId(parseYamlFile(text, PaperSchema), id)
  }

  /** `expectedHash` is the hash from the last read, or null when the paper must not exist yet. */
  async writePaper(paper: Paper, expectedHash: string | null): Promise<string> {
    const valid = PaperSchema.parse(paper)
    return this.writeChecked(join(this.paperDir(valid.id), 'paper.yaml'), toYaml(valid), expectedHash)
  }

  async readNotes(id: string): Promise<{ text: string; hash: string | null }> {
    const text = await readOptional(join(this.paperDir(id), 'notes.md'))
    return text === null ? { text: '', hash: null } : { text, hash: sha256(text) }
  }

  async writeNotes(id: string, text: string, expectedHash: string | null): Promise<string> {
    const path = join(this.paperDir(id), 'notes.md')
    this.requirePaper(id, path)
    return this.writeChecked(path, text, expectedHash)
  }

  /**
   * Where a newly acquired PDF goes under the current policy. Only a PDF that can be downloaded
   * again (the paper has an `oa_pdf_url`) may live in `.cache/`, which is always safe to delete.
   */
  pdfLocation(id: string, opts: { redownloadable: boolean }): string {
    return this.cfg.pdfs.policy === 'download_on_demand' && opts.redownloadable
      ? join(this.cacheDir, 'pdfs', `${id}.pdf`)
      : join(this.paperDir(id), 'paper.pdf')
  }

  /** A local copy wherever it is: policy changes do not move existing files. */
  resolvePdf(id: string): string | null {
    for (const path of [join(this.paperDir(id), 'paper.pdf'), join(this.cacheDir, 'pdfs', `${id}.pdf`)]) {
      if (existsSync(path)) return path
    }
    return null
  }

  /** `newPaper`: the paper.yaml of a paper being created is written right after; any other write needs it already. */
  async writePdf(id: string, bytes: Uint8Array, opts: { redownloadable: boolean; newPaper?: boolean }): Promise<string> {
    const path = this.pdfLocation(id, opts)
    if (!opts.newPaper) this.requirePaper(id, path)
    await atomicWrite(path, bytes)
    return sha256(bytes)
  }

  /** Drops the on-demand copy in the cache, once a PDF in the paper folder takes its place. */
  async removeCachedPdf(id: string): Promise<void> {
    await rm(join(this.cacheDir, 'pdfs', `${id}.pdf`), { force: true })
  }

  async writeContent(id: string, markdown: string, opts: { newPaper?: boolean } = {}): Promise<void> {
    const path = join(this.paperDir(id), 'content.md')
    if (!opts.newPaper) this.requirePaper(id, path)
    await atomicWrite(path, markdown)
  }

  readContent(id: string): Promise<string | null> {
    return readOptional(join(this.paperDir(id), 'content.md'))
  }

  async readSummary(id: string): Promise<ReadResult<SummaryFile> | null> {
    const text = await readOptional(join(this.paperDir(id), 'summary.md'))
    return text === null ? null : parseFrontmatterFile(text, SummaryFileSchema)
  }

  async writeSummary(id: string, summary: SummaryFile, body: string, expectedHash: string | null): Promise<string> {
    const valid = SummaryFileSchema.parse(summary)
    const path = join(this.paperDir(id), 'summary.md')
    this.requirePaper(id, path)
    return this.writeChecked(path, toFrontmatter(valid, body), expectedHash)
  }

  async readExtraction(id: string): Promise<ReadResult<ExtractionFile> | null> {
    const text = await readOptional(join(this.paperDir(id), 'extraction.yaml'))
    return text === null ? null : parseYamlFile(text, ExtractionFileSchema)
  }

  async writeExtraction(id: string, file: ExtractionFile, expectedHash: string | null): Promise<string> {
    const valid = ExtractionFileSchema.parse(file)
    const path = join(this.paperDir(id), 'extraction.yaml')
    this.requirePaper(id, path)
    return this.writeChecked(path, toYaml(valid), expectedHash)
  }

  /** relations.yaml at the project root; null when it does not exist yet. */
  async readRelations(): Promise<ReadResult<RelationsFile> | null> {
    const text = await readOptional(join(this.root, RELATIONS_FILE))
    return text === null ? null : parseYamlFile(text, RelationsFileSchema)
  }

  /** Entries are always written sorted by id, so concurrent edits on two machines merge line by line. */
  async writeRelations(file: RelationsFile, expectedHash: string | null): Promise<string> {
    const valid = RelationsFileSchema.parse({ ...file, relations: sortRelations(file.relations) })
    return this.writeChecked(join(this.root, RELATIONS_FILE), toYaml(valid), expectedHash)
  }

  /**
   * Rewrites a relations.yaml with git conflict markers as the union of both sides (unknown keys kept);
   * null (file untouched) when that is not possible — see `resolveConflictText`. `dropped` counts the
   * invalid entries left out.
   *
   * `expectedHash`, when given, is the hash of the conflicted text the caller showed the user (e.g. from
   * `readRelations()`'s `problem`); if the file changed on disk since then, this throws `ConflictError`
   * instead of resolving content the user never saw. Omit it to resolve whatever is on disk right now.
   */
  async resolveRelationsConflict(expectedHash: string | null = null): Promise<{ dropped: number } | null> {
    const path = join(this.root, RELATIONS_FILE)
    const text = await readOptional(path)
    if (text === null) return null
    const currentHash = sha256(text)
    if (expectedHash !== null && currentHash !== expectedHash) throw new ConflictError(path)
    const merged = resolveConflictText(text)
    if (!merged) return null
    const valid = RelationsFileSchema.parse({ ...merged.file, relations: sortRelations(merged.file.relations) })
    await this.writeChecked(path, toYaml(valid), currentHash)
    return { dropped: merged.dropped }
  }

  /** facet-suggestions.yaml at the project root; null when it does not exist yet. */
  async readFacetSuggestions(): Promise<ReadResult<FacetSuggestionsFile> | null> {
    const text = await readOptional(join(this.root, FACET_SUGGESTIONS_FILE))
    return text === null ? null : parseYamlFile(text, FacetSuggestionsFileSchema)
  }

  /**
   * Suggestions are always written sorted by id, so the sync merges two machines' changes entry by entry. A file with
   * conflict markers is never overwritten, even with its hash: one machine's decisions would be lost.
   */
  async writeFacetSuggestions(file: FacetSuggestionsFile, expectedHash: string | null): Promise<string> {
    const valid = FacetSuggestionsFileSchema.parse({ ...file, suggestions: sortSuggestions(file.suggestions) })
    return this.writeChecked(join(this.root, FACET_SUGGESTIONS_FILE), toYaml(valid), expectedHash, { refuseConflictMarkers: true })
  }

  /** `mappings/<id>/`; an id that is not a mapping id (e.g. one with a path separator) throws. */
  mappingDir(id: string): string {
    if (!MAPPING_ID.test(id)) throw new Error(`Invalid mapping id: ${id}`)
    return join(this.root, MAPPINGS_DIR, id)
  }

  /** A mapping exists while its folder has a protocol.yaml. */
  mappingExists(id: string): boolean {
    return MAPPING_ID.test(id) && existsSync(join(this.mappingDir(id), MAPPING_FILE_NAMES.protocol))
  }

  /** Mapping ids under mappings/ (folders with a protocol.yaml), sorted. */
  async listMappingIds(): Promise<string[]> {
    const entries = await readdir(join(this.root, MAPPINGS_DIR), { withFileTypes: true }).catch(() => [])
    return entries
      .filter((e) => e.isDirectory() && this.mappingExists(e.name))
      .map((e) => e.name)
      .sort()
  }

  /** One file of a mapping; null when it does not exist. */
  async readMappingFile<K extends MappingFileKind>(id: string, kind: K): Promise<ReadResult<MappingFiles[K]> | null> {
    const text = await readOptional(join(this.mappingDir(id), MAPPING_FILE_NAMES[kind]))
    return text === null ? null : parseYamlFile(text, MAPPING_SCHEMAS[kind])
  }

  /**
   * Validated, with its lists sorted, hash-checked (null: it must not exist yet) and never over conflict markers, even
   * with their hash: one machine's searches or decisions would be lost. Writing the protocol with a null hash creates the
   * mapping; every other file is written only next to its protocol.yaml.
   */
  async writeMappingFile<K extends MappingFileKind>(id: string, kind: K, file: MappingFiles[K], expectedHash: string | null): Promise<string> {
    const path = join(this.mappingDir(id), MAPPING_FILE_NAMES[kind])
    if (kind !== 'protocol') this.requireMapping(id, path)
    const valid = MAPPING_SCHEMAS[kind].parse(sortedMappingFile(kind, file))
    return this.writeChecked(path, toYaml(valid), expectedHash, { refuseConflictMarkers: true })
  }

  /** Conversation ids in chats/ (files named `<id>.md`), sorted. */
  async listChatIds(): Promise<string[]> {
    const names = await readdir(join(this.root, CHATS_DIR)).catch(() => [] as string[])
    return names
      .filter(isChatFileName)
      .map((name) => name.slice(0, -3))
      .sort()
  }

  chatPath(id: string): string {
    if (!CHAT_ID.test(id)) throw new Error(`Invalid chat id: ${id}`)
    return join(this.root, CHATS_DIR, chatFileName(id))
  }

  /** chats/<id>.md; null when it does not exist. A frontmatter id that is not the file's own reads as invalid. */
  async readChat(id: string): Promise<ReadResult<ChatFile> | null> {
    const text = await readOptional(this.chatPath(id))
    if (text === null) return null
    const result = parseChat(text)
    if (result.ok && result.value.meta.id !== id) {
      return { ok: false, hash: result.hash, problem: { kind: 'invalid_schema', message: `id ${result.value.meta.id} does not match file ${id}` } }
    }
    return result
  }

  /**
   * One file per conversation, so two machines rarely touch the same one. A file with conflict markers is never
   * overwritten, even with its hash: one machine's messages would be lost. Every message is checked first (a bad one
   * throws and nothing is written), and `cost_usd` is always recomputed from the answers. The hash returned is that of
   * the rendered file, whose message texts are normalized (`cleanMessageText`).
   */
  async writeChat(file: ChatFile, expectedHash: string | null): Promise<string> {
    const messages = checkMessages(file.messages)
    const meta = ChatMetaSchema.parse({ ...file.meta, cost_usd: totalCost(messages) })
    return this.writeChecked(this.chatPath(meta.id), renderChat({ meta, messages }), expectedHash, { refuseConflictMarkers: true })
  }

  /** «Borrar»: only the version read (`expectedHash`); git history keeps it. Nothing to do when it is already gone. */
  async deleteChat(id: string, expectedHash: string): Promise<void> {
    const path = this.chatPath(id)
    const current = await readOptional(path)
    if (current === null) return
    if (sha256(current) !== expectedHash) throw new ConflictError(path)
    await rm(path, { force: true })
  }

  trashDir(id: string): string {
    return join(this.root, TRASH_DIR, id)
  }

  trashExists(id: string): boolean {
    return existsSync(this.trashDir(id))
  }

  /** Moves `papers/<id>/` as a whole to `.trash/<id>/` (one rename) and records when and on which device in trashed.yaml. */
  async trashPaper(id: string, deviceId: string, now: Date): Promise<void> {
    if (!DEVICE_ID.test(deviceId)) throw new Error(`Invalid device id: ${deviceId}`)
    if (!PAPER_ID.test(id) || !this.paperExists(id)) throw new ProjectError(`No paper ${id}`, 'trash_problem')
    if (this.trashExists(id)) throw new ProjectError(`${id} is already in the trash`, 'trash_problem')
    await this.move(this.paperDir(id), this.trashDir(id))
    try {
      const file = TrashedFileSchema.parse({ schema_version: 1, trashed_at: now.toISOString(), device: deviceId })
      await atomicWrite(join(this.trashDir(id), TRASHED_FILE), toYaml(file))
    } catch (error) {
      // Best effort: the folder already moved; without trashed.yaml the trash only lacks the date and the device.
      console.error('trashed.yaml', id, error)
    }
  }

  /** Every folder in `.trash/`, sorted by key; one without paper.yaml is listed too, with `paper: null`. */
  async listTrash(): Promise<TrashedPaper[]> {
    const entries = await readdir(join(this.root, TRASH_DIR), { withFileTypes: true }).catch(() => [])
    const ids = entries
      .filter((e) => e.isDirectory() && PAPER_ID.test(e.name))
      .map((e) => e.name)
      .sort()
    return Promise.all(ids.map(async (id) => ({ id, paper: await this.readTrashedPaper(id), trashed: await this.readTrashedInfo(id) })))
  }

  async readTrashedPaper(id: string): Promise<ReadResult<Paper> | null> {
    const text = await readOptional(join(this.trashDir(id), 'paper.yaml'))
    return text === null ? null : checkPaperId(parseYamlFile(text, PaperSchema), id)
  }

  /**
   * Puts `.trash/<id>/` back as `papers/<as>/` (default: its own key) and drops trashed.yaml. Under another key,
   * `rewrite` gives the paper.yaml for it (written in the trash first, hash-checked). When `papers/<as>/` exists without
   * a paper.yaml (files a sync left behind), the trashed files move into it one by one, paper.yaml last, and a name
   * already taken there is kept beside it as `<name>.trashed.<ext>`. Never over a folder that holds a paper.
   * If the folder cannot be moved, the original paper.yaml goes back into the trash (hash-checked), so the entry stays
   * restorable. `remnant`: something (a subfolder) stayed in the trash, which keeps its entry and trashed.yaml.
   */
  async restorePaper(id: string, opts: { as?: string; rewrite?: (paper: Paper) => Paper } = {}): Promise<{ remnant: boolean }> {
    const as = opts.as ?? id
    if (!PAPER_ID.test(id) || !PAPER_ID.test(as) || !existsSync(join(this.trashDir(id), 'paper.yaml'))) {
      throw new ProjectError(`${id} cannot be restored: no paper.yaml in the trash`, 'trash_problem')
    }
    if (this.paperExists(as)) throw new ProjectError(`papers/${as} already holds a paper`, 'paper_exists')
    if (as !== id) {
      const read = await this.readTrashedPaper(id)
      if (!read?.ok || !opts.rewrite) throw new ProjectError(`${id} cannot be restored as ${as}`, 'trash_problem')
      const next = PaperSchema.parse(opts.rewrite(read.value))
      if (next.id !== as) throw new Error(`The rewritten paper.yaml must have id ${as}`)
      const path = join(this.trashDir(id), 'paper.yaml')
      const original = await readFile(path, 'utf8')
      const rewritten = await this.writeChecked(path, toYaml(next), read.hash)
      try {
        return await this.moveOutOfTrash(id, as)
      } catch (error) {
        // Still in the trash with the new key inside it would never be restorable again: put the original back.
        await this.writeChecked(path, original, rewritten).catch((undo: unknown) => console.error('restore: paper.yaml', id, undo))
        throw error
      }
    }
    return this.moveOutOfTrash(id, as)
  }

  /** Files of a trashed paper (no folders, dot files or trashed.yaml), sorted with paper.yaml last. */
  async listTrashedFiles(id: string): Promise<string[]> {
    const entries = await readdir(this.trashDir(id), { withFileTypes: true }).catch(() => [])
    return entries
      .filter((e) => e.isFile() && FILE_NAME.test(e.name) && e.name !== TRASHED_FILE)
      .map((e) => e.name)
      .sort((a, b) => Number(a === 'paper.yaml') - Number(b === 'paper.yaml') || a.localeCompare(b))
  }

  readTrashedFile(id: string, name: string): Promise<Uint8Array | null> {
    return readOptionalBytes(join(this.trashDir(id), checkFileName(name)))
  }

  readPaperFile(id: string, name: string): Promise<Uint8Array | null> {
    return readOptionalBytes(join(this.paperDir(id), checkFileName(name)))
  }

  /** The first free `<base>.<tag>[-n].<ext>` in `papers/<id>/`, for a copy that must not be lost. */
  freeSibling(id: string, name: string, tag: string): string {
    for (let n = 1; ; n++) {
      const candidate = siblingName(checkFileName(name), tag, n)
      if (!existsSync(join(this.paperDir(id), candidate))) return candidate
    }
  }

  /**
   * Merge on restore: copies one file of a trashed paper into a library paper's folder, as `as` (default: the same
   * name). `expectedHash` is the hash of that target as last read (null: it must not exist). False when there is no such
   * trashed file.
   */
  async adoptTrashedFile(id: string, targetId: string, name: string, opts: { as?: string; expectedHash: string | null }): Promise<boolean> {
    const data = await readOptionalBytes(join(this.trashDir(id), checkFileName(name)))
    if (data === null) return false
    const target = join(this.paperDir(targetId), checkFileName(opts.as ?? name))
    this.requirePaper(targetId, target)
    const current = await readOptionalBytes(target)
    if ((current === null ? null : sha256(current)) !== opts.expectedHash) throw new ConflictError(target)
    await atomicWrite(target, data)
    return true
  }

  /** Merge on restore: a library file that a trashed copy replaces is kept beside it; returns its new name. */
  async keepPaperFileAs(id: string, name: string, tag: string): Promise<string> {
    const from = join(this.paperDir(id), checkFileName(name))
    this.requirePaper(id, from)
    const as = this.freeSibling(id, name, tag)
    await rename(from, join(this.paperDir(id), as))
    return as
  }

  /** After a merge: only the files it took leave the trash, then trashed.yaml and the folder if nothing else is left. True when the folder is gone. */
  async finishMerge(id: string, names: string[]): Promise<boolean> {
    for (const name of names) await rm(join(this.trashDir(id), checkFileName(name)), { force: true })
    return this.removeTrashDirIfDone(id)
  }

  /** «Eliminar definitivamente»: the folder goes for good (git history keeps what git tracked). */
  async deleteTrashed(id: string): Promise<void> {
    if (!PAPER_ID.test(id)) throw new Error(`Invalid paper id: ${id}`)
    await rm(this.trashDir(id), { recursive: true, force: true })
  }

  /** Append-only, one file per device, so synced folders never conflict. */
  async appendCost(deviceId: string, entry: CostEntry): Promise<void> {
    if (!DEVICE_ID.test(deviceId)) throw new Error(`Invalid device id: ${deviceId}`)
    const dir = join(this.root, 'costs')
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, `${deviceId}.jsonl`), `${JSON.stringify(entry)}\n`)
  }

  /**
   * `exports/library.bib` is generated but tracked (only `.cache/` is ignored), so the sync commit reads it: writing
   * it bypasses the gate otherwise, exactly like any other project write. True when the content changed.
   */
  async writeBib(papers: Pick<Paper, 'id' | 'bibtex'>[]): Promise<boolean> {
    const path = join(this.exportsDir, 'library.bib')
    const text = renderLibraryBib(papers)
    const current = await readOptional(path)
    if (current === text) return false
    await atomicWrite(path, text)
    return true
  }

  async readCosts(): Promise<CostEntry[]> {
    const dir = join(this.root, 'costs')
    const files = await readdir(dir).catch(() => [] as string[])
    const entries: CostEntry[] = []
    for (const file of files.filter((f) => f.endsWith('.jsonl'))) {
      const text = await readFile(join(dir, file), 'utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as CostEntry
          if (typeof e.cost_usd === 'number' && typeof e.at === 'string') entries.push(e)
        } catch {
          // A corrupt line (e.g. a sync glitch) is skipped, never fatal.
        }
      }
    }
    return entries
  }

  /** A paper's files are only written next to its paper.yaml: a folder moved to the trash meanwhile is never recreated. */
  private requirePaper(id: string, path: string): void {
    if (!this.paperExists(id)) throw new ConflictError(path)
  }

  /** A mapping's files are only written next to its protocol.yaml: a mapping removed meanwhile is never half recreated. */
  private requireMapping(id: string, path: string): void {
    if (!this.mappingExists(id)) throw new ConflictError(path)
  }

  /** A folder move inside the project; a rename Windows keeps refusing reaches the UI as `folder_busy`. */
  private async move(from: string, to: string): Promise<void> {
    try {
      await moveDir(from, to)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code && MOVE_RETRYABLE.has(code)) throw new ProjectError(`${from} is in use by another program`, 'folder_busy')
      throw error
    }
  }

  private async readTrashedInfo(id: string): Promise<TrashedFile | null> {
    const text = await readOptional(join(this.trashDir(id), TRASHED_FILE))
    if (text === null) return null
    const read = parseYamlFile(text, TrashedFileSchema)
    return read.ok ? read.value : null
  }

  /** `.trash/<id>/` becomes `papers/<as>/`: one move, or file by file (paper.yaml last) into a leftover folder. */
  private async moveOutOfTrash(id: string, as: string): Promise<{ remnant: boolean }> {
    if (!existsSync(this.paperDir(as))) {
      await this.move(this.trashDir(id), this.paperDir(as))
      await rm(join(this.paperDir(as), TRASHED_FILE), { force: true })
      return { remnant: false }
    }
    for (const name of await this.listTrashedFiles(id)) {
      const taken = existsSync(join(this.paperDir(as), name))
      await rename(join(this.trashDir(id), name), join(this.paperDir(as), taken ? this.freeSibling(as, name, 'trashed') : name))
    }
    return { remnant: !(await this.removeTrashDirIfDone(id)) }
  }

  /** Drops trashed.yaml and the folder when nothing else is left in it; true when it is gone. An entry that stays keeps trashed.yaml. */
  private async removeTrashDirIfDone(id: string): Promise<boolean> {
    const left = await readdir(this.trashDir(id)).catch(() => null)
    if (left === null) return true
    if (left.some((name) => name !== TRASHED_FILE)) return false
    await rm(join(this.trashDir(id), TRASHED_FILE), { force: true })
    try {
      await rmdir(this.trashDir(id))
      return true
    } catch {
      return false
    }
  }

  private async writeChecked(path: string, text: string, expectedHash: string | null, opts: { refuseConflictMarkers?: boolean } = {}): Promise<string> {
    const current = await readOptional(path)
    const currentHash = current === null ? null : sha256(current)
    if (currentHash !== expectedHash) throw new ConflictError(path)
    if (opts.refuseConflictMarkers && current !== null && hasConflictMarkers(current)) throw new ConflictError(path)
    await atomicWrite(path, text)
    return sha256(text)
  }

  private async syncIgnoreFiles(): Promise<void> {
    const policy = this.cfg.pdfs.policy
    const ignorePath = join(this.root, '.gitignore')
    const ignore = (await readOptional(ignorePath)) ?? ''
    const nextIgnore = withManagedBlock(ignore, gitignoreLines(policy))
    if (nextIgnore !== ignore) await atomicWrite(ignorePath, nextIgnore)

    const attrPath = join(this.root, '.gitattributes')
    const attrs = await readOptional(attrPath)
    const lines = gitattributesLines(policy)
    if (attrs === null && lines.length === 0) return
    const nextAttrs = withManagedBlock(attrs ?? '', lines)
    if (nextAttrs !== attrs) await atomicWrite(attrPath, nextAttrs)
  }
}

async function readConfig(root: string): Promise<{ cfg: ProjectConfig; hash: string; invalid: InvalidBlocks }> {
  const text = await readOptional(join(root, PROJECT_FILE))
  if (text === null) throw new ProjectError(`No ${PROJECT_FILE} in ${root}`, 'not_a_project')
  const result = parseYamlFile(text, ProjectConfigSchema)
  if (!result.ok) throw new ProjectError(`${PROJECT_FILE}: ${result.problem.message}`, 'invalid_project')
  const raw = parse(text) as Record<string, unknown>
  const invalid: InvalidBlocks = {}
  for (const [key, strict] of Object.entries(LENIENT_BLOCKS) as [LenientBlock, (typeof LENIENT_BLOCKS)[LenientBlock]][]) {
    if (raw[key] !== undefined && !strict.safeParse(raw[key]).success) invalid[key] = raw[key]
  }
  return { cfg: result.value, hash: result.hash, invalid }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function checkPaperId(result: ReadResult<Paper>, id: string): ReadResult<Paper> {
  if (result.ok && result.value.id !== id) {
    return { ok: false, hash: result.hash, problem: { kind: 'invalid_schema', message: `id ${result.value.id} does not match folder ${id}` } }
  }
  return result
}

function checkFileName(name: string): string {
  if (!FILE_NAME.test(name)) throw new Error(`Invalid file name: ${name}`)
  return name
}

async function readOptionalBytes(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Temp folders a cross-disk move left behind when the app stopped in the middle (`.<key>.<hex>.moving`). */
async function removeMovingLeftovers(root: string): Promise<void> {
  for (const dir of [join(root, 'papers'), join(root, TRASH_DIR)]) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (/^\..+\.moving$/.test(name)) await rm(join(dir, name), { recursive: true, force: true })
    }
  }
}
