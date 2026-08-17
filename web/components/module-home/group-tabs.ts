import 'server-only'
import { getTranslations } from 'next-intl/server'
import type { ModuleHomeTab } from './ui'

/**
 * The unified route-tab strip, defined ONCE per nav group. Every page in a
 * group renders the SAME full tab set on the same slider (ModuleHomeTabs) —
 * the module home, the cockpit, and the record list are siblings, and the
 * strip looks identical from any of them. Labels are stable per route
 * (nav-module names for cockpits — never a context-dependent "Overview").
 */

export type TabGroup = 'customers' | 'purchasing' | 'banking' | 'accounting' | 'payroll'

// DASHBOARDS ONLY — record lists (bills, invoices, expense reports, …) are
// menu destinations, never strip tabs. A tab must land on a cockpit/dashboard.
const GROUP_TABS: Record<TabGroup, { href: string; ns: string; key: string }[]> = {
  customers: [
    { href: '/customers', ns: 'customers', key: 'home.title' },
    { href: '/ar', ns: 'nav', key: 'modules.ar' },
  ],
  purchasing: [
    { href: '/purchasing', ns: 'purchasing', key: 'home.title' },
    { href: '/ap', ns: 'nav', key: 'modules.ap' },
    { href: '/expenses', ns: 'nav', key: 'modules.expenses' },
  ],
  banking: [
    { href: '/banking', ns: 'banking', key: 'home.title' },
    { href: '/banking/cash', ns: 'nav', key: 'modules.banking-cash' },
  ],
  accounting: [
    { href: '/accounting', ns: 'accounting', key: 'home.title' },
    { href: '/close', ns: 'nav', key: 'modules.close' },
    { href: '/analytics/financial-health', ns: 'accounting', key: 'home.tabs.health' },
  ],
  payroll: [
    { href: '/payroll', ns: 'payroll', key: 'home.tabs.overview' },
    { href: '/payroll/runs', ns: 'payroll', key: 'home.tabs.runs' },
    { href: '/payroll/remittances', ns: 'payroll', key: 'home.tabs.remittances' },
    // Separation filings (the ROE, a P45) are per-event documents — their own
    // surface, deliberately NOT a year-end section.
    { href: '/payroll/separations', ns: 'payroll', key: 'home.tabs.separations' },
    { href: '/payroll/year-end', ns: 'payroll', key: 'home.tabs.yearEnd' },
    // The NATIVE employee entity list — payroll deliberately has no second one.
    { href: '/entities/employees', ns: 'nav', key: 'modules.employees' },
  ],
}

/**
 * Build the group's tab set with `activeHref` highlighted. `subQs` (e.g.
 * "?sub=<id>") rides along on every tab so the subsidiary lens survives the
 * hop; `exclude` drops routes the viewer can't open (permission gates stay at
 * the call site).
 *
 * Layout rule: render the strip as the LAST (rightmost) header action on
 * every page — sibling buttons vary per page, and a right-anchored strip of
 * constant width is the only way the switcher doesn't jump between tabs.
 */
export async function groupTabs(
  group: TabGroup,
  activeHref: string,
  opts?: { subQs?: string; exclude?: string[] },
): Promise<ModuleHomeTab[]> {
  const defs = GROUP_TABS[group].filter((d) => !opts?.exclude?.includes(d.href))
  const namespaces = [...new Set(defs.map((d) => d.ns))]
  const ts = new Map(
    await Promise.all(namespaces.map(async (ns) => [ns, await getTranslations(ns as never)] as const)),
  )
  return defs.map((d) => ({
    href: `${d.href}${opts?.subQs ?? ''}`,
    label: (ts.get(d.ns) as (key: string) => string)(d.key),
    active: d.href === activeHref,
  }))
}
