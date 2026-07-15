import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { getTranslations } from 'next-intl/server'
import { AppShell } from '../../components/app-shell'
import { ThemeProvider } from '../../components/theme-provider'
import { NavigationProvider } from '../../components/navigation-provider'
import { getAuthz, can } from '../../lib/authz'
import { resolveNav } from '../../lib/nav/resolve'
import { orgInfo } from '../../lib/data'
import { userLocalePreference } from '../../lib/locale'

export const dynamic = 'force-dynamic'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  const [org, localePreference] = await Promise.all([orgInfo(), userLocalePreference()])
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
    <ThemeProvider>
      <NavigationProvider>
        <AppShell
          account={{
            name: authz.user.name,
            email: authz.user.email,
            role: authz.user.role,
            localePreference,
          }}
          orgName={org ? `${org.name} · ${org.base_currency}` : 'openbooks'}
          groups={groups}
          defaultCollapsed={defaultCollapsed}
          showAssistantLauncher={can(authz, 'assistant.use')}
        >
          {children}
        </AppShell>
      </NavigationProvider>
    </ThemeProvider>
  )
}
