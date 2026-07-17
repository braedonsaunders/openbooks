// openbooks module registry — the beaconhs nav registry pattern. Module keys
// are STABLE ids (never change them once shipped); org nav configs reference
// them. The resolver merges this with the org's saved layout and filters by
// permission.

export interface NavModule {
  key: string
  href: string
  label: string
  iconKey: string
  /** Permission required to see the module (wildcards supported). */
  requiredPermission?: string
  /** Stable default workspace key used when no org config exists. */
  group: NavGroupKey
  /** Optional nested section within the group — rendered as a collapsible
   *  sub-menu in the desktop sidebar. Flat consumers (mobile, top nav) ignore
   *  it and render the item inline. */
  subgroup?: string
  exact?: boolean
}

export const NAV_GROUPS = [
  { key: 'home', label: 'Home', iconKey: 'gauge' },
  { key: 'crm', label: 'CRM', iconKey: 'users' },
  { key: 'sales', label: 'Sales', iconKey: 'activity' },
  { key: 'purchases', label: 'Purchases', iconKey: 'clipboard' },
  { key: 'banking', label: 'Banking', iconKey: 'building' },
  { key: 'accounting', label: 'Accounting', iconKey: 'journal' },
  { key: 'projects-time', label: 'Projects & Time', iconKey: 'timer' },
  { key: 'reporting', label: 'Reporting', iconKey: 'file' },
  { key: 'administration', label: 'Administration', iconKey: 'settings' },
] as const

export type NavGroupKey = (typeof NAV_GROUPS)[number]['key']
export const NAV_GROUP_BY_KEY = new Map(NAV_GROUPS.map((group) => [group.key, group]))

// Nav taxonomy: NetSuite-style "workflow workspaces" (Option B). Each top-level
// group is a job-to-be-done that holds BOTH its transactions and its records
// (e.g. Sales = invoices + customers). The same groups drive the left sidebar
// headers and the top-nav dropdown categories. Module keys are STABLE — only
// the `group` assignment changed when the taxonomy was reorganized.
export const NAV_MODULES: NavModule[] = [
  // Home — the daily landing surfaces.
  {
    key: 'dashboard',
    href: '/dashboard',
    label: 'Dashboard',
    iconKey: 'gauge',
    group: 'home',
    exact: true,
  },
  {
    key: 'assistant',
    href: '/assistant',
    label: 'AI Assistant',
    iconKey: 'sparkles',
    group: 'home',
    requiredPermission: 'assistant.use',
  },
  {
    key: 'approvals',
    href: '/approvals',
    label: 'Approvals',
    iconKey: 'check',
    group: 'home',
    requiredPermission: 'ap.approve',
  },
  {
    key: 'documents',
    href: '/documents',
    label: 'File Cabinet',
    iconKey: 'folder',
    group: 'home',
    requiredPermission: 'documents.read',
  },
  {
    key: 'apps',
    href: '/apps',
    label: 'Apps',
    iconKey: 'grid',
    group: 'home',
    requiredPermission: 'apps.use',
  },

  // CRM — relationship lifecycle, daily activities, pipeline, and forecasts.
  {
    key: 'crm-leads',
    href: '/crm/leads',
    label: 'Leads',
    iconKey: 'users',
    group: 'crm',
    requiredPermission: 'crm.accounts.read',
  },
  {
    key: 'crm-prospects',
    href: '/crm/prospects',
    label: 'Prospects',
    iconKey: 'target',
    group: 'crm',
    requiredPermission: 'crm.accounts.read',
  },
  {
    key: 'crm-opportunities',
    href: '/crm/opportunities',
    label: 'Opportunities',
    iconKey: 'activity',
    group: 'crm',
    requiredPermission: 'crm.opportunities.read',
  },
  {
    key: 'crm-activities',
    href: '/crm/activities',
    label: 'Activities',
    iconKey: 'timer',
    group: 'crm',
    requiredPermission: 'crm.activities.read',
  },
  {
    key: 'crm-forecasts',
    href: '/crm/forecasts',
    label: 'Forecasts & Quotas',
    iconKey: 'target',
    group: 'crm',
    requiredPermission: 'crm.forecasts.read',
  },

  // Sales — customer lifecycle, money in, and the shared catalog.
  {
    key: 'customers',
    href: '/entities/customers',
    label: 'Customers',
    iconKey: 'users',
    group: 'sales',
    requiredPermission: 'parties.read',
  },
  {
    key: 'estimates',
    href: '/estimates',
    label: 'Estimates',
    iconKey: 'file',
    group: 'sales',
    requiredPermission: 'ar.read',
  },
  {
    key: 'sales-orders',
    href: '/sales-orders',
    label: 'Sales Orders',
    iconKey: 'clipboard-check',
    group: 'sales',
    requiredPermission: 'ar.read',
  },
  {
    key: 'ar',
    href: '/ar',
    label: 'Invoices',
    iconKey: 'clipboard-check',
    group: 'sales',
    requiredPermission: 'ar.read',
  },
  {
    key: 'receipts',
    href: '/receipts',
    label: 'Customer Payments',
    iconKey: 'check',
    group: 'sales',
    requiredPermission: 'ar.pay',
  },
  {
    key: 'items',
    href: '/items',
    label: 'Items & Services',
    iconKey: 'grid',
    group: 'sales',
    requiredPermission: 'items.read',
  },
  {
    key: 'revenue',
    href: '/revenue',
    label: 'Revenue Recognition',
    iconKey: 'trending-up',
    group: 'sales',
    requiredPermission: 'ar.read',
  },

  // Purchases — money out plus the vendors it flows to.
  {
    key: 'vendors',
    href: '/entities/vendors',
    label: 'Vendors',
    iconKey: 'users',
    group: 'purchases',
    requiredPermission: 'parties.read',
  },
  {
    key: 'purchase-orders',
    href: '/purchase-orders',
    label: 'Purchase Orders',
    iconKey: 'clipboard',
    group: 'purchases',
    requiredPermission: 'ap.read',
  },
  {
    key: 'ap',
    href: '/ap',
    label: 'Bills',
    iconKey: 'clipboard',
    group: 'purchases',
    requiredPermission: 'ap.read',
  },
  {
    key: 'payments',
    href: '/payments',
    label: 'Vendor Payments',
    iconKey: 'check',
    group: 'purchases',
    requiredPermission: 'ap.pay',
  },
  {
    key: 'expenses',
    href: '/expenses',
    label: 'Expenses',
    iconKey: 'scroll',
    group: 'purchases',
    requiredPermission: 'expenses.read',
  },

  // Banking — the bank feed, matching, and reconciliation.
  {
    key: 'banking',
    href: '/banking',
    label: 'Overview',
    iconKey: 'building',
    group: 'banking',
    requiredPermission: 'banking.read',
    exact: true,
  },
  {
    key: 'banking-transactions',
    href: '/banking/transactions',
    label: 'Bank Transactions',
    iconKey: 'journal',
    group: 'banking',
    requiredPermission: 'banking.read',
  },
  {
    key: 'banking-match',
    href: '/banking/match',
    label: 'Match & Categorize',
    iconKey: 'list-checks',
    group: 'banking',
    requiredPermission: 'banking.reconcile',
  },
  {
    key: 'banking-recons',
    href: '/banking/reconciliations',
    label: 'Reconciliations',
    iconKey: 'check',
    group: 'banking',
    requiredPermission: 'banking.reconcile',
  },
  {
    key: 'banking-rules',
    href: '/banking/rules',
    label: 'Reconciliation Rules',
    iconKey: 'workflow',
    group: 'banking',
    requiredPermission: 'banking.reconcile',
  },
  {
    key: 'banking-imports',
    href: '/banking/imports',
    label: 'Import History',
    iconKey: 'database',
    group: 'banking',
    requiredPermission: 'banking.read',
  },

  // Accounting — the ledger core: journals, chart, assets, tax, close, and budgets.
  {
    key: 'journal',
    href: '/journal',
    label: 'Journals',
    iconKey: 'journal',
    group: 'accounting',
    requiredPermission: 'gl.read',
  },
  {
    key: 'accounts',
    href: '/accounts',
    label: 'Chart of Accounts',
    iconKey: 'layers',
    group: 'accounting',
    requiredPermission: 'gl.read',
  },
  {
    key: 'assets',
    href: '/assets',
    label: 'Fixed Assets',
    iconKey: 'building',
    group: 'accounting',
    requiredPermission: 'assets.read',
  },
  {
    key: 'tax-depreciation',
    href: '/assets/tax-pools',
    label: 'Tax Depreciation',
    iconKey: 'receipt',
    group: 'accounting',
    requiredPermission: 'assets.read',
  },
  {
    key: 'budgets',
    href: '/budgets',
    label: 'Budgets',
    iconKey: 'target',
    group: 'accounting',
    requiredPermission: 'budgets.read',
  },
  {
    key: 'tax-filings',
    href: '/tax',
    label: 'Tax Filings',
    iconKey: 'receipt',
    group: 'accounting',
    requiredPermission: 'reports.read',
  },
  {
    key: 'continuous-close',
    href: '/continuous-close',
    label: 'Continuous Close',
    iconKey: 'activity',
    group: 'accounting',
    requiredPermission: 'assistant.use',
  },
  {
    key: 'close',
    href: '/close',
    label: 'Period Close',
    iconKey: 'timer',
    group: 'accounting',
    requiredPermission: 'close.read',
  },

  // Projects & Time — projects, employees, and timesheets. The unified party directory
  // (/parties) is intentionally NOT in the nav: parties are an internal
  // abstraction; end users only see role-scoped views (Customers, Vendors,
  // Employees).
  {
    key: 'projects',
    href: '/projects',
    label: 'Projects',
    iconKey: 'timer',
    group: 'projects-time',
    requiredPermission: 'projects.read',
  },
  {
    key: 'employees',
    href: '/entities/employees',
    label: 'Employees',
    iconKey: 'clipboard-check',
    group: 'projects-time',
    requiredPermission: 'parties.read',
  },
  {
    key: 'timesheets',
    href: '/timesheets',
    label: 'Weekly Timesheets',
    iconKey: 'timer',
    group: 'projects-time',
    requiredPermission: 'time.read',
  },

  // Reporting — financial statements, native analytics, custom dashboards, and saved views.
  {
    key: 'reports',
    href: '/reports',
    label: 'Financial Reports',
    iconKey: 'file',
    group: 'reporting',
    requiredPermission: 'reports.read',
  },
  // Analytics is ONE nav entry — the /analytics hub. The individual dashboards
  // (Financial Health, Customer Intelligence, …) are cards on the hub, not nav
  // modules (user directive 2026-07-16). No `exact` so it stays active on
  // /analytics/* sub-routes.
  {
    key: 'analytics',
    href: '/analytics',
    label: 'Analytics',
    iconKey: 'activity',
    group: 'reporting',
    requiredPermission: 'reports.read',
  },
  {
    key: 'insights',
    href: '/insights',
    label: 'Dashboard Builder',
    iconKey: 'sparkles',
    group: 'reporting',
    requiredPermission: 'insights.read',
  },
  {
    key: 'saved-searches',
    href: '/knowledge/views',
    label: 'Saved Views',
    iconKey: 'search',
    group: 'reporting',
    requiredPermission: 'reports.read',
  },

  // Administration — the admin surfaces. Three entries: "Admin Center" is the
  // /admin landing hub (users, roles, navigation, audit, sync as cards); "Company Settings" is
  // the configuration workspace (tax, dimensions, terms, company &
  // accounting); "Build" is a nested sub-menu holding every authoring tool —
  // Custom Records, custom fields, forms & views, PDF templates, scripts,
  // apps, and the API surfaces.
  //
  // The Admin Center entry's gating is intentionally left unset here and handled
  // specially in the nav resolver (see ADMIN_MODULE_KEY): it appears for anyone
  // holding any admin-ish permission, and the landing page re-gates each card.
  // Every other entry uses a normal permission gate.
  {
    key: 'admin',
    href: '/admin',
    label: 'Admin Center',
    iconKey: 'settings',
    group: 'administration',
    exact: true,
  },
  {
    key: 'admin-setup',
    href: '/admin/setup',
    label: 'Company Settings',
    iconKey: 'wrench',
    group: 'administration',
    requiredPermission: 'admin.setup.manage',
  },

  // Build — the developer/authoring tools, nested under Administration. The desktop
  // sidebar renders the subgroup as a collapsible section; the top nav renders
  // it as a flyout sub-menu. The subgroup header itself links to the
  // /admin/build landing hub (see NAV_SUBGROUPS).
  {
    key: 'records',
    href: '/records/types',
    label: 'Custom Records',
    iconKey: 'grid',
    group: 'administration',
    subgroup: 'Build',
    requiredPermission: 'records.manage_types',
  },
  {
    key: 'admin-custom-fields',
    href: '/admin/custom-fields',
    label: 'Custom Fields',
    iconKey: 'tag',
    group: 'administration',
    subgroup: 'Build',
    requiredPermission: 'admin.custom_fields.manage',
  },
  {
    key: 'admin-customization',
    href: '/admin/customization',
    label: 'Forms & Views',
    iconKey: 'panel-left',
    group: 'administration',
    subgroup: 'Build',
    requiredPermission: 'admin.customization.manage',
  },
  {
    key: 'admin-pdf-templates',
    href: '/admin/pdf-templates',
    label: 'PDF Templates',
    iconKey: 'scroll',
    group: 'administration',
    subgroup: 'Build',
    requiredPermission: 'admin.customization.manage',
  },
  {
    key: 'admin-scripts',
    href: '/admin/scripts',
    label: 'Scripts',
    iconKey: 'code',
    group: 'administration',
    subgroup: 'Build',
    requiredPermission: 'scripts.manage',
  },
  {
    key: 'flows',
    href: '/admin/flows',
    label: 'Flows',
    iconKey: 'workflow',
    group: 'administration',
    subgroup: 'Build',
    requiredPermission: 'flows.manage',
  },
  {
    key: 'admin-apps',
    href: '/admin/apps',
    label: 'App Builder',
    iconKey: 'library',
    group: 'administration',
    subgroup: 'Build',
    requiredPermission: 'apps.manage',
  },
  {
    key: 'sql',
    href: '/query',
    label: 'Query Console',
    iconKey: 'database',
    group: 'administration',
    subgroup: 'Build',
    requiredPermission: 'sql.execute',
  },
  {
    key: 'admin-api-keys',
    href: '/admin/api-keys',
    label: 'API Keys',
    iconKey: 'key',
    group: 'administration',
    subgroup: 'Build',
    requiredPermission: 'api.keys.manage',
  },
  {
    key: 'api-docs',
    href: '/api-docs',
    label: 'API Docs',
    iconKey: 'code',
    group: 'administration',
    subgroup: 'Build',
    requiredPermission: 'api.keys.manage',
  },
]

/**
 * Permissions that grant access to *some* corner of the admin hub. The nav
 * resolver shows the single 'Administration' entry when a user holds any of
 * these; the /admin landing then filters individual cards by their own
 * permission. Keep in sync with the cards on the admin landing page.
 */
export const ADMIN_HUB_PERMISSIONS = [
  'admin.users.manage',
  'admin.roles.manage',
  'admin.nav.manage',
  'admin.audit.read',
  'admin.ai.manage',
  'admin.sandboxes.manage',
  'sync.run',
] as const

/** Nav module key for the collapsed Administration entry (special-cased in the resolver). */
export const ADMIN_MODULE_KEY = 'admin'

/**
 * Subgroup metadata, keyed by the registry-default subgroup label. `href`
 * makes the subgroup header itself a link (to a landing hub that re-gates its
 * cards), on top of expanding/flying out its children.
 */
export const NAV_SUBGROUPS: Record<string, { href: string; iconKey?: string }> = {
  Build: { href: '/admin/build', iconKey: 'construction' },
}

export const MODULE_BY_KEY = new Map(NAV_MODULES.map((m) => [m.key, m]))

// --- org config shape (stored in org_nav_configs.config) -------------------

export type NavItemConfig =
  | {
      kind: 'module'
      moduleKey: string
      label?: string
      iconKey?: string
      hidden?: boolean
      mobile?: boolean
    }
  | {
      kind: 'link'
      href: string
      label: string
      iconKey?: string
      hidden?: boolean
      mobile?: boolean
    }

export interface NavGroupConfig {
  id: string
  label: string
  items: NavItemConfig[]
}

export interface OrgNavConfig {
  version: 2
  groups: NavGroupConfig[]
}

/** Default layout computed from the registry (used when no org config). */
export function defaultNavConfig(): OrgNavConfig {
  const mobileModules = new Set(['dashboard', 'approvals', 'ar', 'ap'])
  const groups: NavGroupConfig[] = NAV_GROUPS.map((group) => ({
    id: group.key,
    label: group.label,
    items: [],
  }))
  for (const m of NAV_MODULES) {
    const group = groups.find((candidate) => candidate.id === m.group)
    if (!group) throw new Error(`Unknown navigation group: ${m.group}`)
    group.items.push({
      kind: 'module',
      moduleKey: m.key,
      ...(mobileModules.has(m.key) ? { mobile: true } : {}),
    })
  }
  return { version: 2, groups }
}
