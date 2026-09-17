import { navContributionSchema } from '@openbooks/engine/src/extensions/contribution-schemas.ts'
/** The installer and manifest use this same registry-validated schema. */
export { navContributionSchema }

export function parseNavContribution(raw: unknown) {
  const result = navContributionSchema.safeParse(raw)
  return result.success
    ? { ok: true as const, contribution: result.data }
    : { ok: false as const, errors: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) }
}
