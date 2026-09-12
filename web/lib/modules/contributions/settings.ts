import { settingContributionSchema } from '@openbooks/engine/src/modules/contribution-schemas.ts'
import type { z } from 'zod'

/** Values and effective-dated history are owned by the engine projection service. */
export { settingContributionSchema }
export type SettingContribution = z.infer<typeof settingContributionSchema>
export const SETTING_PROJECTION_TARGET = 'orgs' as const

export function parseSettingContribution(raw: unknown) {
  const result = settingContributionSchema.safeParse(raw)
  return result.success
    ? { ok: true as const, contribution: result.data }
    : { ok: false as const, errors: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) }
}
