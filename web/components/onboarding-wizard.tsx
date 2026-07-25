import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { canSwitchIndustry } from '@/lib/industries'
import { INDUSTRIES } from '@/lib/industries'
import { SetupWizard } from '@/app/(app)/admin/setup/wizard/SetupWizard'
import type { Authz } from '@/lib/authz'

/**
 * First-login wizard overlay. Rendered by the app layout when the org has not
 * yet completed onboarding (`settings.onboarding.setupComplete` is falsy) and
 * the user has setup permission. Non-admins never see it — they land on the
 * dashboard normally. The wizard calls `router.refresh()` on close so the
 * layout re-evaluates and the overlay disappears.
 */
export async function OnboardingWizard({ authz }: { authz: Authz }) {
  const orgId = authz.user.orgId
  const [org, switchable] = await Promise.all([
    db.execute(sql`
      select name, legal_name, base_currency, country, settings
        from orgs where id = ${orgId}`),
    canSwitchIndustry(orgId),
  ])
  const row = (org as unknown as { rows: { name: string; legal_name: string | null; base_currency: string; country: string; settings: Record<string, unknown> }[] }).rows[0]
  const settings = row?.settings ?? {}

  return (
    <SetupWizard
      open
      industries={INDUSTRIES}
      initial={{
        name: row?.name ?? '',
        legalName: row?.legal_name ?? '',
        country: row?.country ?? '',
        baseCurrency: row?.base_currency ?? '',
        fiscalYearStartMonth: typeof settings.fiscalYearStartMonth === 'number' ? settings.fiscalYearStartMonth : 1,
        industry: (settings.industry as string) ?? null,
      }}
      canSwitchIndustry={switchable}
      isRerun={false}
    />
  )
}
