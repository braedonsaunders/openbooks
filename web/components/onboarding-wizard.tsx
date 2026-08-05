import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { canSwitchIndustry } from '@/lib/industries'
import { INDUSTRIES } from '@/lib/industries'
import { SetupWizard } from '@/app/(app)/admin/setup/wizard/SetupWizard'
import type { Authz } from '@/lib/authz'
import { onboardingStatus } from '@/lib/onboarding'
import { FEATURES, featureEnabled, resolvedFeatureState } from '@/lib/features'
import { isBookStart, isCloseCadence, isComplexityLevel, isMonthlyActivityLevel, isTaxPosition, isTeamSize } from '@/lib/workspace-profile'

/**
 * First-login wizard overlay. The app layout renders this only for users with
 * setup permission; this component independently checks the durable org state
 * so completion and deferral are authoritative server-side decisions.
 */
export async function OnboardingWizard({ authz }: { authz: Authz }) {
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
  if (onboardingStatus(settings) !== 'required') return null

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
      isRerun={false}
      suppressOnWizardRoute
    />
  )
}
