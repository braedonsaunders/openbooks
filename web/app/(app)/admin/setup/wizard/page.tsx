import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getAuthz, can } from '../../../../../lib/authz'
import { db } from '@openbooks/engine/src/db.ts'
import { INDUSTRIES, canSwitchIndustry } from '../../../../../lib/industries'
import { SetupWizard } from './SetupWizard'

export const dynamic = 'force-dynamic'

/**
 * The setup wizard page — used when the user re-runs the wizard from the
 * Features page ("Run setup wizard" button). On first login the wizard is
 * rendered inline by the app layout (see web/app/(app)/layout.tsx).
 */
export default async function WizardPage() {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  if (!can(authz, 'admin.setup.manage')) redirect('/')

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
      isRerun
    />
  )
}
