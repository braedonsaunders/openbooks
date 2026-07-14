// openbooks app shell — the beaconhs shell minus tenancy: sidebar + header
// (mobile toggle, org name, account menu) + scrolling main + mobile tab bar.

import { type SidebarNavGroup } from './sidebar-nav'
import { AppSidebar } from './app-sidebar'
import { AccountMenu } from './account-menu'
import { MobileNavProvider } from './mobile-nav'
import { MobileNavToggle } from './mobile-nav-toggle'
import { MobileTabBar } from './mobile-tab-bar'

export function AppShell({
  account,
  orgName,
  groups,
  defaultCollapsed = false,
  children,
}: {
  account: { name: string; email: string; role: string }
  orgName: string
  groups: SidebarNavGroup[]
  defaultCollapsed?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex h-screen overflow-hidden">
      <AppSidebar groups={groups} defaultCollapsed={defaultCollapsed} />

      <MobileNavProvider>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden [padding-top:env(safe-area-inset-top)]">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 sm:gap-4 sm:px-6 dark:border-slate-800 dark:bg-slate-900">
            <MobileNavToggle groups={groups} />
            <span className="truncate text-sm font-medium text-slate-600 dark:text-slate-300">
              {orgName}
            </span>
            <div className="flex-1" />
            <AccountMenu name={account.name} email={account.email} role={account.role} />
          </header>

          <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-50 dark:bg-slate-950">
            {children}
          </main>

          <MobileTabBar groups={groups} />
        </div>
      </MobileNavProvider>
    </div>
  )
}
