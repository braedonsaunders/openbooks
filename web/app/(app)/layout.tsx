import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { AppShell } from '../../components/app-shell'
import { ThemeProvider } from '../../components/theme-provider'
import { NavigationProvider } from '../../components/navigation-provider'
import { getAuthz, can } from '../../lib/authz'
import { resolveNav } from '../../lib/nav/resolve'
import { orgInfo } from '../../lib/data'

export const dynamic = 'force-dynamic'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  const org = await orgInfo()
  const jar = await cookies()
  const defaultCollapsed = jar.get('sidebar_collapsed')?.value === '1'

  const groups = await resolveNav(
    authz.user.orgId,
    (permission) => permission === undefined || can(authz, permission),
    authz.user.role,
  )

  return (
    <ThemeProvider>
      <NavigationProvider>
        <AppShell
          account={{ name: authz.user.name, email: authz.user.email, role: authz.user.role }}
          orgName={org ? `${org.name} · ${org.base_currency}` : 'openbooks'}
          groups={groups}
          defaultCollapsed={defaultCollapsed}
        >
          {children}
        </AppShell>
      </NavigationProvider>
    </ThemeProvider>
  )
}
