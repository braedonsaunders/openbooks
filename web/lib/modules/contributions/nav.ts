import { navContributionSchema } from '@openbooks/engine/src/modules/contribution-schemas.ts'
import type { z } from 'zod'

/** The installer and manifest use this same registry-validated schema. */
export { navContributionSchema }
export type NavContribution = z.infer<typeof navContributionSchema>
export const NAV_PROJECTION_TARGET = 'org_nav_configs' as const

export function parseNavContribution(raw: unknown) {
  const result = navContributionSchema.safeParse(raw)
  return result.success
    ? { ok: true as const, contribution: result.data }
    : { ok: false as const, errors: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) }
}
