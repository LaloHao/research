import { z } from 'zod'

/** `.trash/<key>/trashed.yaml`: when, and on which device, a paper was removed from the library. */
export const TrashedFileSchema = z.looseObject({
  schema_version: z.literal(1),
  trashed_at: z.string(),
  device: z.string()
})
export type TrashedFile = z.infer<typeof TrashedFileSchema>

/** Why a trash folder cannot be restored as is; each has a translation under `trash.problems.<kind>`. */
export const TRASH_PROBLEMS = ['missing_paper_yaml', 'conflict_markers', 'invalid_yaml', 'invalid_schema'] as const
export type TrashProblem = (typeof TRASH_PROBLEMS)[number]

/** One paper in the trash, as the Papelera view lists it. */
export interface TrashEntry {
  id: string
  title: string
  authors_label: string
  year: number | null
  /** From trashed.yaml; null when that file is missing or unreadable. */
  trashed_at: string | null
  device: string | null
  /** trashed.yaml names this device. */
  this_device: boolean
  problem: TrashProblem | null
}

/** Papers moved by one «Quitar de la biblioteca»; `error` is the code of the paper that stopped the rest. */
export interface TrashOutcome {
  moved: string[]
  error: string | null
}

/** The same paper is back in the library (as `target`): only the user decides to merge them. */
export interface RestoreConflict {
  id: string
  title: string
  target: string
}

export interface RestoreOutcome {
  /** `key` is where the paper now is: its own key, a free one (another paper took it), or the paper it was merged into. */
  restored: { id: string; key: string }[]
  /** Papers left in the trash until the user picks «Fusionar» or «Cancelar». */
  conflicts: RestoreConflict[]
  failed: { id: string; error: string }[]
}

/** What «Eliminar definitivamente» or «Vaciar papelera» would delete: exactly `ids`, which the confirmation then sends back. */
export interface DeletePlan {
  ids: string[]
  papers: number
  relations: number
}

/** Some trashed papers, or the whole trash named explicitly (never an empty list). Only for planning a deletion. */
export type TrashTarget = string[] | 'all'
