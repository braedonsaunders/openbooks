import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getAuthz, can } from '../../../../../lib/authz'
import { db } from '@openbooks/engine/src/db.ts'
import { INDUSTRIES, canSwitchIndustry } from '../../../../../lib/industries'
import { FEATURES, featureEnabled, resolvedFeatureState } from '../../../../../lib/features'
import { SetupWizard } from './SetupWizard'
import { isBookStart, isCloseCadence, isComplexityLevel, isMonthlyActivityLevel, isTaxPosition, isTeamSize } from '../../../../../lib/workspace-profile'

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
  const [org, switchable, features] = await Promise.all([
    db.execute(sql`
      select name, legal_name, base_currency, country, settings
        from orgs where id = ${orgId}`),
    canSwitchIndustry(orgId),
    resolvedFeatureState(orgId),
  ])
  const row = (org as unknown as { rows: { name: string; legal_name: string | null; base_currency: string; country: string; settings: Record<string, unknown> }[] }).rows[0]
  const settings = row?.settings ?? {}
  const storedProfile = settings.workspaceProfile as Record<string, unknown> | undefined

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
        workspaceProfile: {
          teamSize: isTeamSize(storedProfile?.teamSize) ? storedProfile.teamSize : 'solo',
          complexity: isComplexityLevel(storedProfile?.complexity) ? storedProfile.complexity : 'essentials',
          bookStart: isBookStart(storedProfile?.bookStart) ? storedProfile.bookStart : 'fresh',
          taxPosition: isTaxPosition(storedProfile?.taxPosition) ? storedProfile.taxPosition : 'unsure',
          monthlyActivity: isMonthlyActivityLevel(storedProfile?.monthlyActivity) ? storedProfile.monthlyActivity : 'light',
          closeCadence: isCloseCadence(storedProfile?.closeCadence) ? storedProfile.closeCadence : 'monthly',
        },
        features: {
          inventory: featureEnabled(features, 'inventory'),
          timeTracking: featureEnabled(features, 'timeTracking'),
          multiSubsidiary: featureEnabled(features, 'multiSubsidiary'),
          multiCurrency: featureEnabled(features, 'multiCurrency'),
          projects: featureEnabled(features, 'projects'),
          subscriptionBilling: featureEnabled(features, 'subscriptionBilling'),
          orders: featureEnabled(features, 'orders'),
          crm: featureEnabled(features, 'crm'),
          bankFeeds: featureEnabled(features, 'bankFeeds'),
          onlinePayments: featureEnabled(features, 'onlinePayments'),
          fixedAssets: featureEnabled(features, 'fixedAssets'),
          payroll: featureEnabled(features, 'payroll'),
        },
        allFeatures: Object.fromEntries(
          FEATURES.map((feature) => [feature.key, featureEnabled(features, feature.key)]),
        ),
      }}
      canSwitchIndustry={switchable}
      isRerun
    />
  )
}
