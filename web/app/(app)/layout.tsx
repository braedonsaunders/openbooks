import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { getTranslations } from 'next-intl/server'
import { AppShell } from '../../components/app-shell'
import { SandboxBanner } from '../../components/sandbox-banner'
import { ThemeProvider } from '../../components/theme-provider'
import { NavigationProvider } from '../../components/navigation-provider'
import { getAuthz, can } from '../../lib/authz'
import { resolveNav } from '../../lib/nav/resolve'
import { shellEnvironments } from '../../lib/environments'
import { userLocalePreference } from '../../lib/locale'
import { resolveNavMode, userNavModePreference } from '../../lib/nav-mode-resolve'
import { orgInfo } from '../../lib/data'
import { MoneyProvider } from '../../components/money-provider'
import { OnboardingWizard } from '../../components/onboarding-wizard'

export const dynamic = 'force-dynamic'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  const [localePreference, navMode, navModePreference, environments, org] = await Promise.all([
    userLocalePreference(),
    resolveNavMode(authz.user.id, authz.user.orgId),
    userNavModePreference(authz.user.id, authz.user.orgId),
    shellEnvironments(authz),
    orgInfo(authz.user.orgId),
  ])
  if (!org?.base_currency) throw new Error('Organization base currency is not configured')
  const jar = await cookies()
  const defaultCollapsed = jar.get('sidebar_collapsed')?.value === '1'

  const tNav = await getTranslations('nav')
  const groups = await resolveNav(
    authz.user.orgId,
    (permission) => permission === undefined || can(authz, permission),
    authz.user.role,
    // Fall back to the registry label when a module has no translation yet, so
    // a newly-added nav module can never crash the whole app (MISSING_MESSAGE).
    (key) => {
      try {
        return tNav(key)
      } catch {
        return ''
      }
    },
  )

  return (
    <MoneyProvider currency={org.base_currency}>
      <ThemeProvider>
        <NavigationProvider>
          <AppShell
          account={{
            name: authz.user.name,
            email: authz.user.email,
            role: authz.user.role,
            localePreference,
            navModePreference,
          }}
          environments={environments}
          groups={groups}
          navMode={navMode}
          defaultCollapsed={defaultCollapsed}
          createPermissions={{
            accountsReceivable: can(authz, 'ar.create'),
            accountsPayable: can(authz, 'ap.create'),
            journal: can(authz, 'gl.post'),
            customerPayments: can(authz, 'ar.pay'),
            vendorPayments: can(authz, 'ap.pay'),
            expenses: can(authz, 'expenses.create'),
            parties: can(authz, 'parties.manage'),
            items: can(authz, 'items.manage'),
            projects: can(authz, 'projects.manage'),
            assets: can(authz, 'assets.manage'),
          }}
          canReadParties={can(authz, 'parties.read')}
          canManageParties={can(authz, 'parties.manage')}
          canReadActivities={can(authz, 'crm.activities.read')}
          canManageWages={can(authz, 'admin.setup.manage')}
          >
            {authz.user.envKind !== 'production' && (
              <SandboxBanner name={authz.user.sandboxName} />
            )}
            {children}
          </AppShell>
          {can(authz, 'admin.setup.manage') && <OnboardingWizard authz={authz} />}
        </NavigationProvider>
      </ThemeProvider>
    </MoneyProvider>
  )
}
