import type { FileProblemKind } from '../../shared/library'

export class ConflictError extends Error {
  constructor(readonly path: string) {
    super(`File changed on disk since it was read: ${path}`)
    this.name = 'ConflictError'
  }
}

/** `code` tells the UI what went wrong when creating or opening a project. */
export class ProjectError extends Error {
  constructor(
    message: string,
    readonly code?: 'project_exists' | 'not_a_project' | 'invalid_project'
  ) {
    super(message)
    this.name = 'ProjectError'
  }
}

export type FileProblem = { kind: FileProblemKind; message: string }

export type ReadResult<T> = { ok: true; value: T; hash: string } | { ok: false; problem: FileProblem; hash: string }
