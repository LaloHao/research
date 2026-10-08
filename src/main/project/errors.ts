export class ConflictError extends Error {
  constructor(readonly path: string) {
    super(`File changed on disk since it was read: ${path}`)
    this.name = 'ConflictError'
  }
}

export class ProjectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectError'
  }
}

export type FileProblem = { kind: 'conflict_markers' | 'invalid_yaml' | 'invalid_schema'; message: string }

export type ReadResult<T> = { ok: true; value: T; hash: string } | { ok: false; problem: FileProblem; hash: string }
