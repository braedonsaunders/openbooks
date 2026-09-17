import { settingContributionSchema } from '@openbooks/engine/src/extensions/contribution-schemas.ts'
/** Values and effective-dated history are owned by the engine projection service. */
export { settingContributionSchema }

export function parseSettingContribution(raw: unknown) {
  const result = settingContributionSchema.safeParse(raw)
  return result.success
    ? { ok: true as const, contribution: result.data }
    : { ok: false as const, errors: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) }
}
