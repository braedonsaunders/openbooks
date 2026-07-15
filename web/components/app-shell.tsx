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
import { AccountMenu } from './account-menu'
import { AssistantLauncher } from './assistant-launcher'
import { MobileNavProvider } from './mobile-nav'
import { MobileNavToggle } from './mobile-nav-toggle'
import { MobileTabBar } from './mobile-tab-bar'

export function AppShell({
  account,
  orgName,
  groups,
  navMode = 'sidebar',
  defaultCollapsed = false,
  showAssistantLauncher = false,
  children,
}: {
  account: {
    name: string
    email: string
    role: string
    localePreference: Locale | null
    navModePreference: NavMode | null
  }
  orgName: string
  groups: SidebarNavGroup[]
  /** Resolved app-menu layout (user preference, else org default, else sidebar). */
  navMode?: NavMode
  defaultCollapsed?: boolean
  /** Renders the global ⌘K assistant launcher (user holds assistant.use). */
  showAssistantLauncher?: boolean
  children: React.ReactNode
}) {
  const topbar = navMode === 'topbar'
  return (
    <div className="flex h-screen overflow-hidden">
      {topbar ? null : <AppSidebar groups={groups} defaultCollapsed={defaultCollapsed} />}

      <MobileNavProvider>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden [padding-top:env(safe-area-inset-top)]">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 sm:gap-4 sm:px-6 dark:border-slate-800 dark:bg-slate-900">
            <MobileNavToggle groups={groups} />
            {topbar ? (
              // The rail (and its logo) is gone — brand moves into the header
              // on desktop; below lg the org name stays, as in sidebar mode.
              <>
                <Logo className="hidden h-7 w-auto shrink-0 lg:block" />
                <span className="truncate text-sm font-medium text-slate-600 lg:hidden dark:text-slate-300">
                  {orgName}
                </span>
                <TopNav groups={groups} />
                <div className="flex-1 lg:hidden" />
              </>
            ) : (
              <>
                <span className="truncate text-sm font-medium text-slate-600 dark:text-slate-300">
                  {orgName}
                </span>
                <div className="flex-1" />
              </>
            )}
            {showAssistantLauncher ? <AssistantLauncher compact={topbar} /> : null}
            <AccountMenu
              name={account.name}
              email={account.email}
              role={account.role}
              localePreference={account.localePreference}
              navModePreference={account.navModePreference}
            />
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
