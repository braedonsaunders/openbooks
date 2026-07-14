import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { AppShell } from '../../components/app-shell'
import { ThemeProvider } from '../../components/theme-provider'
import { NavigationProvider } from '../../components/navigation-provider'
import type { SidebarNavGroup } from '../../components/sidebar-nav'
import { currentUser } from '../../lib/auth'
import { orgInfo } from '../../lib/data'

export const dynamic = 'force-dynamic'

const NAV_GROUPS: SidebarNavGroup[] = [
  {
    label: 'Overview',
    items: [
      { href: '/', label: 'Dashboard', iconKey: 'gauge', exact: true },
      { href: '/approvals', label: 'Approvals', iconKey: 'check' },
    ],
  },
  {
    label: 'Money out',
    items: [{ href: '/ap', label: 'Payables', iconKey: 'clipboard' }],
  },
  {
    label: 'Ledger',
    items: [
      { href: '/journal', label: 'Journal', iconKey: 'journal' },
      { href: '/accounts', label: 'Chart of Accounts', iconKey: 'layers' },
    ],
  },
  {
    label: 'Insight',
    items: [
      { href: '/reports', label: 'Reports', iconKey: 'file' },
      { href: '/query', label: 'SQL', iconKey: 'database' },
    ],
  },
  {
    label: 'System',
    items: [{ href: '/sync', label: 'Sync', iconKey: 'link' }],
  },
]

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser()
  if (!user) redirect('/login')
  const org = await orgInfo()
  const jar = await cookies()
  const defaultCollapsed = jar.get('sidebar_collapsed')?.value === '1'

  return (
    <ThemeProvider>
      <NavigationProvider>
        <AppShell
          account={{ name: user.name, email: user.email, role: user.role }}
          orgName={org ? `${org.name} · ${org.base_currency}` : 'openbooks'}
          groups={NAV_GROUPS}
          defaultCollapsed={defaultCollapsed}
        >
          {children}
        </AppShell>
      </NavigationProvider>
    </ThemeProvider>
  )
}
