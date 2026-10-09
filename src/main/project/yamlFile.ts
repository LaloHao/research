import { parse, stringify } from 'yaml'
import { z } from 'zod'
import { sha256 } from './atomicWrite'
import type { ReadResult } from './errors'

const CONFLICT_MARKER = /^(<{7} |={7}$|>{7} )/m

export function parseYamlFile<T>(text: string, schema: z.ZodType<T>): ReadResult<T> {
  const hash = sha256(text)
  if (CONFLICT_MARKER.test(text)) {
    return { ok: false, hash, problem: { kind: 'conflict_markers', message: 'File contains git conflict markers' } }
  }
  let raw: unknown
  try {
    raw = parse(text)
  } catch (error) {
    return { ok: false, hash, problem: { kind: 'invalid_yaml', message: (error as Error).message } }
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    return { ok: false, hash, problem: { kind: 'invalid_schema', message: z.prettifyError(result.error) } }
  }
  return { ok: true, value: result.data, hash }
}

function stripUndefined(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj
  }
  if (typeof obj !== 'object') {
    return obj
  }
  if (Array.isArray(obj)) {
    return obj.map(stripUndefined)
  }
  const result: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(obj)) {
    if (val !== undefined) {
      result[key] = stripUndefined(val)
    }
  }
  return result
}

export function toYaml(value: unknown): string {
  return stringify(stripUndefined(value), { lineWidth: 0 })
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/

/** Parses a Markdown file whose YAML frontmatter holds the data; the body is presentation only. */
export function parseFrontmatterFile<T>(text: string, schema: z.ZodType<T>): ReadResult<T> {
  const hash = sha256(text)
  if (CONFLICT_MARKER.test(text)) {
    return { ok: false, hash, problem: { kind: 'conflict_markers', message: 'File contains git conflict markers' } }
  }
  const m = text.match(FRONTMATTER)
  if (!m) return { ok: false, hash, problem: { kind: 'invalid_yaml', message: 'Missing YAML frontmatter' } }
  return { ...parseYamlFile(m[1], schema), hash }
}

export function toFrontmatter(value: unknown, body: string): string {
  return `---\n${toYaml(value)}---\n\n${body.trimEnd()}\n`
}
