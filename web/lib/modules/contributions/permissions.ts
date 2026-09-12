import { permissionContributionSchema } from '@openbooks/engine/src/modules/contribution-schemas.ts'
import type { z } from 'zod'

/** Declaration availability comes from installed active versions; grants stay in app_roles. */
export { permissionContributionSchema }
export type PermissionContribution = z.infer<typeof permissionContributionSchema>
export const PERMISSION_PROJECTION_TARGET = 'app_roles' as const

export function parsePermissionContribution(raw: unknown) {
  const result = permissionContributionSchema.safeParse(raw)
  return result.success
    ? { ok: true as const, contribution: result.data }
    : { ok: false as const, errors: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) }
}
