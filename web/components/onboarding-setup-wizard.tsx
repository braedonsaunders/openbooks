import { canonicalTimeZone, listCanonicalTimeZones } from '@openbooks/engine/platform/time-zone'
import { installablePayrollPacks } from '@openbooks/engine/src/payroll/packs.ts'
import { canSwitchIndustry } from '@/lib/industries'
import { INDUSTRIES } from '@/lib/industries'
import { SetupWizard } from '@/app/(app)/admin/setup/wizard/SetupWizard'
import type { Authz } from '@/lib/authz'
import { setupLaunchActions } from '@/lib/setup-launch-actions'
import { FEATURES, featureEnabled, resolvedFeatureState } from '@/lib/features'
import { isBookStart, isCloseCadence, isComplexityLevel, isMonthlyActivityLevel, isTaxPosition, isTeamSize } from '@/lib/workspace-profile'
import type { OnboardingOrg } from './onboarding-wizard'

/** The first-run setup wizard for an organization whose onboarding is required. */
export async function OnboardingSetupWizard({ authz, org: row }: { authz: Authz; org: OnboardingOrg | undefined }) {
  const orgId = authz.user.orgId
  const settings = row?.settings ?? {}
  const storedProfile = settings.workspaceProfile as Record<string, unknown> | undefined

  const [switchable, features] = await Promise.all([
    canSwitchIndustry(orgId),
    resolvedFeatureState(orgId),
  ])

  return (
    <SetupWizard
      open
      launchActions={setupLaunchActions(authz)}
      suppressOnPaths={['/inbox']}
      industries={INDUSTRIES}
      initial={{
        name: row?.name ?? '',
        legalName: row?.legal_name ?? '',
        country: row?.country ?? '',
        baseCurrency: row?.base_currency ?? '',
        fiscalYearStartMonth: typeof settings.fiscalYearStartMonth === 'number' ? settings.fiscalYearStartMonth : 1,
        timeZone: canonicalTimeZone(settings.timeZone) ?? null,
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
      payrollPacks={installablePayrollPacks()}
      timeZones={listCanonicalTimeZones()}
    />
  )
}
