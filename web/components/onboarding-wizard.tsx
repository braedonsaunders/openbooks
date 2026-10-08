import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import type { Authz } from '@/lib/authz'
import { onboardingStatus } from '@/lib/onboarding'

/**
 * First-login wizard overlay. The app layout renders this only for users with
 * setup permission; this component independently checks the durable org state
 * so completion and deferral are authoritative server-side decisions.
 *
 * The wizard renders on EVERY page for admins, so it establishes that it is
 * actually needed before loading anything it would render: the wizard, its
 * industry and payroll-pack catalogs and the feature state load only for an
 * organization whose onboarding is still required.
 */
export async function OnboardingWizard({ authz }: { authz: Authz }) {
  const org = (await db.execute<OnboardingOrg>(sql`
    select name, legal_name, base_currency, country, settings
      from orgs where id = ${authz.user.orgId}`))
  const row = org.rows[0]
  if (onboardingStatus(row?.settings ?? {}) !== 'required') return null
  const { OnboardingSetupWizard } = await import('./onboarding-setup-wizard')
  return <OnboardingSetupWizard authz={authz} org={row} />
}

export type OnboardingOrg = {
  name: string
  legal_name: string | null
  base_currency: string
  country: string
  settings: Record<string, unknown>
}
