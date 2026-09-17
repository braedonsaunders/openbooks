import { permissionContributionSchema } from '@openbooks/engine/src/extensions/contribution-schemas.ts'
/** Declaration availability comes from installed active versions; grants stay in app_roles. */
export { permissionContributionSchema }

export function parsePermissionContribution(raw: unknown) {
  const result = permissionContributionSchema.safeParse(raw)
  return result.success
    ? { ok: true as const, contribution: result.data }
    : { ok: false as const, errors: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) }
}
