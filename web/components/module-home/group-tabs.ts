import 'server-only'
import { getTranslations } from 'next-intl/server'
import { can, type Authz } from '../../lib/authz'
import { featureEnabled, orgFeatureState } from '../../lib/features'
import type { ModuleHomeTab } from './ui'

/**
 * The unified route-tab strip, defined ONCE per nav group. Every page in a
 * group renders the SAME full tab set on the same slider (ModuleHomeTabs) —
 * the module home, the cockpit, and the record list are siblings, and the
 * strip looks identical from any of them. Labels are stable per route
 * (nav-module names for cockpits — never a context-dependent "Overview").
 */

export type TabGroup = 'customers' | 'purchasing' | 'banking' | 'accounting' | 'payroll'

// DASHBOARDS AND WORKING SURFACES — a tab lands on a cockpit, or on the ONE
// canonical list for a thing the group works on daily (accounts, pay runs,
// employees). It never lands on a document list a menu already owns (bills,
// invoices, expense reports), and never on a second copy of a list another
// tab already shows.
const GROUP_TABS: Record<TabGroup, { href: string; ns: string; key: string }[]> = {
  customers: [
    // `home.tabs.overview`, not `home.title`: the cockpit and the account
    // list are both called "Customers", and two identically labelled tabs on
    // one strip name nothing. Payroll settles the same clash the same way.
    { href: '/customers', ns: 'customers', key: 'home.tabs.overview' },
    // The NATIVE account list — every lifecycle stage on one surface, which
    // is why there is no Leads tab and no Prospects tab beside it.
    { href: '/entities/customers', ns: 'nav', key: 'modules.customers' },
    { href: '/crm/opportunities', ns: 'nav', key: 'modules.crm-opportunities' },
    { href: '/crm/activities', ns: 'nav', key: 'modules.crm-activities' },
    { href: '/crm/forecasts', ns: 'nav', key: 'modules.crm-forecasts' },
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
 * Tabs that sit behind an optional-feature switch must not render or navigate
 * while the org has that feature off — a dead tab pointing at a 404 is a nav
 * leak even though every target keeps its own authoritative page/API gate.
 */
const TAB_FEATURE: Record<string, string> = {
  '/crm/opportunities': 'crm',
  '/crm/activities': 'crm',
  '/crm/forecasts': 'crm',
  '/expenses': 'expenses',
  '/banking': 'banking',
  '/banking/cash': 'banking',
  '/payroll': 'payroll',
  '/payroll/runs': 'payroll',
  '/payroll/remittances': 'payroll',
  '/payroll/separations': 'payroll',
  '/payroll/year-end': 'payroll',
  '/close': 'continuousClose',
}

/**
 * Build the group's tab set with `activeHref` highlighted. `subQs` (e.g.
 * "?sub=<id>") rides along on every tab so the subsidiary lens survives the
 * hop; `exclude` drops routes the viewer can't open (permission gates stay at
 * the call site); `orgId` scopes the feature check so tabs whose target
 * module's Features switch is off are dropped here as well.
 *
 * Layout rule: render the strip as the LAST (rightmost) header action on
 * every page — sibling buttons vary per page, and a right-anchored strip of
 * constant width is the only way the switcher doesn't jump between tabs.
 */
export async function groupTabs(
  group: TabGroup,
  activeHref: string,
  opts: { subQs?: string; exclude?: string[]; orgId: string },
): Promise<ModuleHomeTab[]> {
  const state = await orgFeatureState(opts.orgId)
  const defs = GROUP_TABS[group].filter((d) => {
    const feature = TAB_FEATURE[d.href]
    return (
      !opts.exclude?.includes(d.href) &&
      (!feature || featureEnabled(state, feature))
    )
  })
  const namespaces = [...new Set(defs.map((d) => d.ns))]
  const ts = new Map(
    await Promise.all(namespaces.map(async (ns) => [ns, await getTranslations(ns as never)] as const)),
  )
  return defs.map((d) => ({
    href: `${d.href}${opts.subQs ?? ''}`,
    label: (ts.get(d.ns) as (key: string) => string)(d.key),
    active: d.href === activeHref,
  }))
}

/** The permission each Customers-group tab's destination enforces. */
const CUSTOMER_TAB_PERMISSION: Record<string, string> = {
  '/entities/customers': 'parties.read',
  '/crm/opportunities': 'crm.opportunities.read',
  '/crm/activities': 'crm.activities.read',
  '/crm/forecasts': 'crm.forecasts.read',
  '/ar': 'ar.read',
}

/**
 * The Customers strip with permission exclusions already applied.
 *
 * This group's tabs sit behind FIVE different permissions, so leaving the
 * exclusion list to each of the six call sites guarantees they drift: one
 * page would offer a Forecasts tab that 403s while its neighbour hides it.
 * Every page in the group calls this instead of `groupTabs` directly.
 */
export async function customerGroupTabs(
  authz: Authz,
  activeHref: string,
  opts: { subQs?: string } = {},
): Promise<ModuleHomeTab[]> {
  const exclude = Object.entries(CUSTOMER_TAB_PERMISSION)
    .filter(([, permission]) => !can(authz, permission))
    .map(([href]) => href)
  return groupTabs('customers', activeHref, { ...opts, exclude, orgId: authz.user.orgId })
}
