// openbooks app shell — the beaconhs shell minus tenancy: sidebar + header
// (mobile toggle, org name, account menu) + scrolling main + mobile tab bar.
//
// Two desktop layouts, picked server-side by resolveNavMode: "sidebar" (the
// default left rail) or "topbar" (NetSuite-style TopNav dropdowns in the
// header, no rail). Below lg both modes fall back to the mobile drawer +
// tab bar, so mobile behavior is identical either way.

import { type SidebarNavGroup } from './sidebar-nav'
import type { Locale } from '../i18n/config'
import type { NavMode } from '../lib/nav-mode'
import { Logo } from './brand-logo'
import { AppSidebar } from './app-sidebar'
import { TopNav } from './top-nav'
import { GlobalSearch } from './global-search'
import { AccountMenu } from './account-menu'
import { NotificationsBell } from './notifications-bell'
import type { WorkspaceEnvironments } from '../lib/environments'
import { MobileNavProvider } from './mobile-nav'
import { MobileNavToggle } from './mobile-nav-toggle'
import { MobileTabBar } from './mobile-tab-bar'
import { GlobalCreateMenu, type GlobalCreatePermissions } from './global-create-menu'
import { GlobalPartyDrawerHost } from './global-party-drawer-host'

export function AppShell({
  account,
  environments,
  groups,
  navMode = 'sidebar',
  defaultCollapsed = false,
  createPermissions,
  canReadParties,
  canManageParties,
  children,
}: {
  account: {
    name: string
    email: string
    role: string
    localePreference: Locale | null
    navModePreference: NavMode | null
  }
  /** Production org + its sandboxes, for the environment switcher. */
  environments: WorkspaceEnvironments
  groups: SidebarNavGroup[]
  /** Resolved app-menu layout (user preference, else org default, else sidebar). */
  navMode?: NavMode
  defaultCollapsed?: boolean
  createPermissions: GlobalCreatePermissions
  canReadParties: boolean
  canManageParties: boolean
  children: React.ReactNode
}) {
  const topbar = navMode === 'topbar'
  return (
    <div className="flex h-screen overflow-hidden">
      {topbar ? null : <AppSidebar groups={groups} defaultCollapsed={defaultCollapsed} />}

      <MobileNavProvider>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden [padding-top:env(safe-area-inset-top)]">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 sm:gap-3 sm:px-4 dark:border-slate-800 dark:bg-slate-900">
            <MobileNavToggle groups={groups} />
            {topbar ? (
              // The rail (and its logo) is gone — brand moves into the header
              // on desktop.
              <>
                <Logo className="hidden h-7 w-auto shrink-0 lg:block" />
                <TopNav groups={groups} />
                <div className="flex-1 lg:hidden" />
                <GlobalSearch className="hidden w-52 shrink-0 lg:block xl:w-64" />
              </>
            ) : (
              <GlobalSearch className="mx-auto w-full max-w-lg flex-1" />
            )}
            <div className="flex shrink-0 items-center gap-1">
              <GlobalCreateMenu permissions={createPermissions} />
              <NotificationsBell />
              <AccountMenu
                name={account.name}
                email={account.email}
                role={account.role}
                localePreference={account.localePreference}
                navModePreference={account.navModePreference}
                environments={environments}
              />
            </div>
          </header>

          <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-50 dark:bg-slate-950">
            {children}
          </main>

          <MobileTabBar groups={groups} />
          {canReadParties ? <GlobalPartyDrawerHost canManage={canManageParties} /> : null}
        </div>
      </MobileNavProvider>
    </div>
  )
}
