import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { getTranslations } from 'next-intl/server'
import { AppShell } from '../../components/app-shell'
import { RouteTransition } from '../../components/route-transitions'
import '../drawer-paper-lab.css'
import { PageSkeleton } from '../../components/page-skeleton'
import { SandboxBanner } from '../../components/sandbox-banner'
import { ThemeProvider } from '../../components/theme-provider'
import { NavigationProvider } from '../../components/navigation-provider'
import { getAuthz, can } from '../../lib/authz'
import { resolveLocalNavigation } from '../../lib/nav/local'
import { ViewTabsProvider } from '../../components/module-home/view-tabs'
import { resolveNav } from '../../lib/nav/resolve'
import { shellEnvironments } from '../../lib/environments'
import { userLocalePreference } from '../../lib/locale'
import { resolveNavMode, userNavModePreference } from '../../lib/nav-mode-resolve'
import { orgInfo } from '../../lib/data'
import { orgFeatureState, featureEnabled } from '../../lib/features'
import { isFeedbackReady } from '../../lib/feedback/config'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { BusinessDateProvider } from '../../components/business-date-provider'
import { MoneyProvider } from '../../components/money-provider'
import { OnboardingWizard } from '../../components/onboarding-wizard'

export const dynamic = 'force-dynamic'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  const [localePreference, navMode, navModePreference, environments, org, today, featureState, feedbackConfigured] = await Promise.all([
    userLocalePreference(),
    resolveNavMode(authz.user.id, authz.user.orgId),
    userNavModePreference(authz.user.id, authz.user.orgId),
    shellEnvironments(authz),
    orgInfo(authz.user.orgId),
    businessToday(authz.user.orgId),
    // These shell capabilities use ordinary feature defaults. Read their
    // switches together and retain the registry's parent dependencies.
    orgFeatureState(authz.user.orgId),
    // Installation-level, not a tenant feature: the operator configures one
    // issue destination for the whole deployment (web/lib/feedback/config.ts).
    isFeedbackReady(),
  ])
  const crmEnabled = featureEnabled(featureState, 'crm')
  const ordersEnabled = featureEnabled(featureState, 'orders')
  const expensesEnabled = featureEnabled(featureState, 'expenses')
  const projectsEnabled = featureEnabled(featureState, 'projects')
  const assetsEnabled = featureEnabled(featureState, 'fixedAssets')
  const cashSalesEnabled = featureEnabled(featureState, 'cashSales')
  if (!org?.base_currency) throw new Error('Organization base currency is not configured')
  const feedbackReady = feedbackConfigured && can(authz, 'feedback.use')
  const jar = await cookies()
  const defaultCollapsed = jar.get('sidebar_collapsed')?.value === '1'

  const tNav = await getTranslations('nav')
  const [groups, localNavigation] = await Promise.all([resolveNav(
    authz.user.orgId,
    (permission) => permission === undefined || can(authz, permission),
    authz.user.roles.map(({ key }) => key),
    // Fall back to the registry label when a module has no translation yet, so
    // a newly-added nav module can never crash the whole app (MISSING_MESSAGE).
    (key) => {
      try {
        return tNav(key)
      } catch {
        return ''
      }
    },
    // Existence check for optional catalog branches (nav.modulesShort):
    // silent, so absent shorts never log a development MISSING_MESSAGE.
    (key) => {
      try {
        return tNav.has(key)
      } catch {
        return false
      }
    },
  ), resolveLocalNavigation(authz)])

  return (
    <MoneyProvider currency={org.base_currency}>
      <BusinessDateProvider today={today}>
      <ThemeProvider>
        <NavigationProvider>
          <ViewTabsProvider groups={localNavigation.groups} preferences={localNavigation.preferences} ownership={localNavigation.ownership} managed>
          <AppShell
          account={{
            name: authz.user.name,
            email: authz.user.email,
            roles: authz.user.roles,
            localePreference,
            navModePreference,
          }}
          environments={environments}
          groups={groups}
          searchScope={`${authz.user.orgId}:${authz.user.id}`}
          navMode={navMode}
          defaultCollapsed={defaultCollapsed}
          createPermissions={{
            accountsReceivable: can(authz, 'ar.create'),
            accountsPayable: can(authz, 'ap.create'),
            journal: can(authz, 'gl.post'),
            customerPayments: can(authz, 'ar.pay'),
            vendorPayments: can(authz, 'ap.pay'),
            expenses: can(authz, 'expenses.create') && expensesEnabled,
            parties: can(authz, 'parties.manage'),
            items: can(authz, 'items.manage'),
            projects: can(authz, 'projects.manage') && projectsEnabled,
            assets: can(authz, 'assets.manage') && assetsEnabled,
            orders: ordersEnabled,
            cashSales: can(authz, 'cash_sales.create') && cashSalesEnabled,
          }}
          canReadParties={can(authz, 'parties.read')}
          canManageParties={can(authz, 'parties.manage')}
          canReadActivities={crmEnabled && can(authz, 'crm.activities.read')}
          canManageWages={can(authz, 'admin.setup.manage')}
          feedback={feedbackReady ? { appVersion: process.env.OPENBOOKS_VERSION || 'development' } : null}
          >
            {authz.user.envKind === 'sandbox' && (
              <SandboxBanner name={authz.user.sandboxName} kind={authz.user.envKind} />
            )}
            {/* Page content streams behind the skeleton so the shell
              (sidebar/header) paints before slow page loaders resolve.
              Every ModuleView page renders inside {children}, so this one
              boundary covers them without touching each page. The route
              transition inside it animates navigation between pages. */}
            <Suspense fallback={<PageSkeleton />}>
              <RouteTransition>{children}</RouteTransition>
            </Suspense>
          </AppShell>
          {can(authz, 'admin.setup.manage') && <OnboardingWizard authz={authz} />}
          </ViewTabsProvider>
        </NavigationProvider>
      </ThemeProvider>
      </BusinessDateProvider>
    </MoneyProvider>
  )
}
