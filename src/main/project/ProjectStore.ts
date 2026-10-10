import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PaperSchema, ProjectConfigSchema, type Paper, type ProjectConfig } from '../../shared/schemas'
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
import { atomicWrite, sha256 } from './atomicWrite'
import { ConflictError, ProjectError, type ReadResult } from './errors'
import { gitattributesLines, gitignoreLines, withManagedBlock } from './gitFiles'
import { parseFrontmatterFile, parseYamlFile, toFrontmatter, toYaml } from './yamlFile'

export const PROJECT_FILE = 'project.yaml'

/** Blocks of project.yaml read leniently: an invalid one is replaced by defaults in memory but never on disk by accident. */
const LENIENT_BLOCKS = { llm: LlmConfigShape, thesis: ThesisContextSchema, snowball: SnowballSchema } as const
type LenientBlock = keyof typeof LENIENT_BLOCKS
type InvalidBlocks = Partial<Record<LenientBlock, unknown>>

/** The only writer of the project folder (exports/ and .cache/ aside). */
export class ProjectStore {
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
    return new ProjectStore(root, cfg, hash, invalid)
  }

  get config(): ProjectConfig {
    return this.cfg
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
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'paper.yaml')))
      .map((e) => e.name)
      .sort()
  }

  async readPaper(id: string): Promise<ReadResult<Paper>> {
    const text = await readFile(join(this.paperDir(id), 'paper.yaml'), 'utf8')
    const result = parseYamlFile(text, PaperSchema)
    if (result.ok && result.value.id !== id) {
      return { ok: false, hash: result.hash, problem: { kind: 'invalid_schema', message: `id ${result.value.id} does not match folder ${id}` } }
    }
    return result
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
    return this.writeChecked(join(this.paperDir(id), 'notes.md'), text, expectedHash)
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

  async writePdf(id: string, bytes: Uint8Array, opts: { redownloadable: boolean }): Promise<string> {
    await atomicWrite(this.pdfLocation(id, opts), bytes)
    return sha256(bytes)
  }

  async writeContent(id: string, markdown: string): Promise<void> {
    await atomicWrite(join(this.paperDir(id), 'content.md'), markdown)
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
    return this.writeChecked(join(this.paperDir(id), 'summary.md'), toFrontmatter(valid, body), expectedHash)
  }

  async readExtraction(id: string): Promise<ReadResult<ExtractionFile> | null> {
    const text = await readOptional(join(this.paperDir(id), 'extraction.yaml'))
    return text === null ? null : parseYamlFile(text, ExtractionFileSchema)
  }

  async writeExtraction(id: string, file: ExtractionFile, expectedHash: string | null): Promise<string> {
    const valid = ExtractionFileSchema.parse(file)
    return this.writeChecked(join(this.paperDir(id), 'extraction.yaml'), toYaml(valid), expectedHash)
  }

  /** Append-only, one file per device, so synced folders never conflict. */
  async appendCost(deviceId: string, entry: CostEntry): Promise<void> {
    if (!/^[A-Za-z0-9-]+$/.test(deviceId)) throw new Error(`Invalid device id: ${deviceId}`)
    const dir = join(this.root, 'costs')
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, `${deviceId}.jsonl`), `${JSON.stringify(entry)}\n`)
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

  private async writeChecked(path: string, text: string, expectedHash: string | null): Promise<string> {
    const current = await readOptional(path)
    const currentHash = current === null ? null : sha256(current)
    if (currentHash !== expectedHash) throw new ConflictError(path)
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
