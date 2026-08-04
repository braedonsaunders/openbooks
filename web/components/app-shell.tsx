// OpenBooks app shell: sidebar, header, and main content surface.
// (mobile toggle, org name, account menu) + scrolling main + mobile tab bar.
//
// Two desktop layouts, picked server-side by resolveNavMode: "sidebar" (the
// default left rail) or "topbar" (source platform-style TopNav dropdowns in the
// header, no rail). Below lg both modes fall back to the mobile drawer +
// tab bar, so mobile behavior is identical either way.

import { type SidebarNavGroup } from './sidebar-nav'
import type { Locale } from '../i18n/config'
import type { NavMode } from '../lib/nav-mode'
import { BrandHomeLink } from './brand-home-link'
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
import { GlobalReportDrawerHost } from './global-report-drawer-host'
import { AppLauncherLink, HeaderNavLink } from './header-nav-link'

export function AppShell({
  account,
  environments,
  groups,
  navMode = 'topbar',
  defaultCollapsed = false,
  createPermissions,
  canReadParties,
  canManageParties,
  canReadActivities,
  canManageWages,
  children,
}: {
  account: {
    name: string
    email: string
    roles: ReadonlyArray<{ key: string; name: string }>
    localePreference: Locale | null
    navModePreference: NavMode | null
  }
  /** Production org + its sandboxes, for the environment switcher. */
  environments: WorkspaceEnvironments
  groups: SidebarNavGroup[]
  /** Resolved app-menu layout (user preference, else org default, else topbar). */
  navMode?: NavMode
  defaultCollapsed?: boolean
  createPermissions: GlobalCreatePermissions
  canReadParties: boolean
  canManageParties: boolean
  canReadActivities: boolean
  canManageWages: boolean
  children: React.ReactNode
}) {
  const topbar = navMode === 'topbar'
  const appItem = groups.flatMap((group) => group.items).find((item) => item.href === '/apps')
  const docsItem = groups.flatMap((group) => group.items).find((item) => item.href === '/docs')
  const navigationGroups = groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.href !== '/apps' && item.href !== '/docs'),
    }))
    .filter((group) => group.items.length > 0)
  return (
    <div className="flex h-screen overflow-hidden">
      {topbar ? null : <AppSidebar groups={navigationGroups} defaultCollapsed={defaultCollapsed} />}

      <MobileNavProvider>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden [padding-top:env(safe-area-inset-top)]">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 sm:gap-3 sm:px-4 dark:border-slate-800 dark:bg-slate-900">
            <MobileNavToggle groups={navigationGroups} />
            {topbar ? (
              // The rail (and its logo) is gone — brand moves into the header
              // on desktop.
              <>
                <BrandHomeLink className="hidden lg:inline-flex" />
                <TopNav groups={navigationGroups} />
                <div className="flex-1 lg:hidden" />
                <GlobalSearch className="hidden w-52 shrink-0 lg:block xl:w-64" />
              </>
            ) : (
              <GlobalSearch className="mx-auto w-full max-w-lg flex-1" />
            )}
            <div className="flex shrink-0 items-center gap-1">
              {docsItem ? <HeaderNavLink item={docsItem} /> : null}
              {appItem ? <AppLauncherLink item={appItem} /> : null}
              <GlobalCreateMenu permissions={createPermissions} />
              <NotificationsBell />
              <AccountMenu
                name={account.name}
                email={account.email}
                roles={account.roles}
                localePreference={account.localePreference}
                navModePreference={account.navModePreference}
                environments={environments}
              />
            </div>
          </header>

          <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-50 dark:bg-slate-950">
            {children}
          </main>

          <MobileTabBar groups={navigationGroups} />
          <GlobalReportDrawerHost />
          {canReadParties ? (
            <GlobalPartyDrawerHost
              canManage={canManageParties}
              canReadActivities={canReadActivities}
              canManageWages={canManageWages}
            />
          ) : null}
        </div>
      </MobileNavProvider>
    </div>
  )
}
