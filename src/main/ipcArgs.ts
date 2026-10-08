import { z } from 'zod'
import { PDF_POLICIES } from '../shared/schemas'

/** Validators for arguments arriving from the renderer: anything unexpected is rejected before it reaches the app. */
export const ipcArgs = {
  paperId: z.string().regex(/^[a-z][a-z0-9]*$/),
  projectName: z.string().trim().min(1),
  text: z.string(),
  optionalText: z.string().optional(),
  hash: z.string().nullable(),
  paths: z.array(z.string().min(1)),
  jobId: z.number().int().nonnegative(),
  /** `lastProjectPath` is managed by the main process only. */
  settingsPatch: z.strictObject({ contactEmail: z.string().optional() }),
  projectPatch: z.strictObject({
    name: z.string().trim().min(1).optional(),
    contentLanguage: z.string().min(2).optional(),
    pdfPolicy: z.enum(PDF_POLICIES).optional()
  })
}

export class InvalidIpcArgument extends Error {
  constructor(name: string) {
    super(`Invalid IPC argument: ${name}`)
    this.name = 'InvalidIpcArgument'
  }
}

export function arg<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new InvalidIpcArgument(name)
  return result.data
}
