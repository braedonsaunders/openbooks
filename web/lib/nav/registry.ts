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
  /** Optional-feature gate — hidden while the org has the feature off. */
  featureKey?: string
  /** Stable default workspace key used when no org config exists. */
  group: NavGroupKey
  /** Optional nested section within the group — rendered as a collapsible
   *  sub-menu in the desktop sidebar. Flat consumers (mobile, top nav) ignore
   *  it and render the item inline. */
  subgroup?: string
  exact?: boolean
}

export const NAV_GROUPS = [
  { key: 'my-work', label: 'My Work', iconKey: 'gauge' },
  { key: 'customers', label: 'Customers', iconKey: 'users' },
  { key: 'purchasing', label: 'Purchasing', iconKey: 'clipboard' },
  { key: 'operations', label: 'Operations', iconKey: 'package' },
  { key: 'banking', label: 'Banking', iconKey: 'building' },
  { key: 'accounting', label: 'Accounting', iconKey: 'journal' },
  { key: 'insights', label: 'Insights', iconKey: 'activity' },
  { key: 'settings', label: 'Settings', iconKey: 'settings' },
] as const

export type NavGroupKey = (typeof NAV_GROUPS)[number]['key']
export const NAV_GROUP_BY_KEY = new Map(NAV_GROUPS.map((group) => [group.key, group]))

/**
 * Module homes — group headers that navigate to a landing cockpit for the
 * whole workspace (mirrors NAV_SUBGROUPS for sub-menu headers). Only groups
 * whose home page actually exists belong here; the sidebar renders a plain
 * toggle header for the rest. Group homes match exact-only in active-state
 * resolution so they never swallow their children's routes.
 */
export const NAV_GROUP_HOMES: Partial<Record<NavGroupKey, string>> = {
  'my-work': '/dashboard',
  customers: '/customers',
  purchasing: '/purchasing',
  banking: '/banking',
  accounting: '/accounting',
  insights: '/analytics',
  settings: '/admin',
}

// Nav taxonomy: eight stable job-to-be-done workspaces. Customer work follows
// the complete relationship-to-cash journey; purchasing follows buy-to-pay;
// operations owns delivery/catalog/people; accounting owns financial control.
// Module keys remain stable because tenant configurations reference them.
export const NAV_MODULES: NavModule[] = [
  // My Work — the signed-in user's daily landing surfaces.
  {
    key: 'dashboard',
    href: '/dashboard',
    label: 'Dashboard',
    iconKey: 'gauge',
    group: 'my-work',
    exact: true,
  },
  {
    key: 'assistant',
    href: '/assistant',
    label: 'Assistant',
    iconKey: 'sparkles',
    group: 'my-work',
    requiredPermission: 'assistant.use',
  },
  {
    key: 'approvals',
    href: '/approvals',
    label: 'Approvals',
    iconKey: 'check',
    group: 'my-work',
    requiredPermission: 'ap.approve',
  },
  {
    key: 'documents',
    href: '/documents',
    label: 'File Cabinet',
    iconKey: 'folder',
    group: 'my-work',
    requiredPermission: 'documents.read',
  },
  {
    key: 'apps',
    href: '/apps',
    label: 'Apps',
    iconKey: 'grid',
    group: 'my-work',
    requiredPermission: 'apps.use',
  },

  // Customers — relationship lifecycle, pipeline, sales, and collection.
  {
    key: 'crm-leads',
    href: '/crm/leads',
    label: 'Leads',
    iconKey: 'users',
    group: 'customers',
    subgroup: 'relationships',
    requiredPermission: 'crm.accounts.read',
  },
  {
    key: 'crm-prospects',
    href: '/crm/prospects',
    label: 'Prospects',
    iconKey: 'target',
    group: 'customers',
    subgroup: 'relationships',
    requiredPermission: 'crm.accounts.read',
  },
  {
    key: 'crm-opportunities',
    href: '/crm/opportunities',
    label: 'Opportunities',
    iconKey: 'activity',
    group: 'customers',
    subgroup: 'pipeline',
    requiredPermission: 'crm.opportunities.read',
  },
  {
    key: 'crm-activities',
    href: '/crm/activities',
    label: 'Activities',
    iconKey: 'timer',
    group: 'customers',
    subgroup: 'relationships',
    requiredPermission: 'crm.activities.read',
  },
  {
    key: 'crm-forecasts',
    href: '/crm/forecasts',
    label: 'Forecasts & Quotas',
    iconKey: 'target',
    group: 'customers',
    subgroup: 'pipeline',
    requiredPermission: 'crm.forecasts.read',
  },

  // Customer records and the sell-to-collect workflow.
  {
    key: 'customers',
    href: '/entities/customers',
    label: 'Customers',
    iconKey: 'users',
    group: 'customers',
    subgroup: 'relationships',
    requiredPermission: 'parties.read',
  },
  {
    key: 'estimates',
    href: '/estimates',
    label: 'Estimates',
    iconKey: 'file',
    group: 'customers',
    subgroup: 'sell-collect',
    requiredPermission: 'ar.read',
  },
  {
    key: 'sales-orders',
    href: '/sales-orders',
    label: 'Sales Orders',
    iconKey: 'clipboard-check',
    group: 'customers',
    subgroup: 'sell-collect',
    requiredPermission: 'ar.read',
  },
  {
    key: 'ar',
    href: '/ar',
    label: 'Accounts Receivable',
    iconKey: 'gauge',
    group: 'customers',
    subgroup: 'sell-collect',
    requiredPermission: 'ar.read',
    exact: true,
  },
  {
    key: 'collections',
    href: '/collections',
    label: 'Recurring & Collections',
    iconKey: 'history',
    group: 'customers',
    subgroup: 'sell-collect',
    requiredPermission: 'documents.manage',
  },
  {
    key: 'ar-invoices',
    href: '/ar/invoices',
    label: 'Invoices',
    iconKey: 'clipboard-check',
    group: 'customers',
    subgroup: 'sell-collect',
    requiredPermission: 'ar.read',
  },
  {
    key: 'receipts',
    href: '/receipts',
    label: 'Customer Payments',
    iconKey: 'check',
    group: 'customers',
    subgroup: 'sell-collect',
    requiredPermission: 'ar.pay',
  },
  {
    key: 'items',
    href: '/items',
    label: 'Items & Services',
    iconKey: 'grid',
    group: 'operations',
    subgroup: 'catalog',
    requiredPermission: 'items.read',
  },
  {
    key: 'revenue',
    href: '/revenue',
    label: 'Revenue Recognition',
    iconKey: 'trending-up',
    group: 'accounting',
    subgroup: 'revenue-accounting',
    requiredPermission: 'ar.read',
  },

  // Purchasing — vendor records and the buy-to-pay workflow.
  {
    key: 'vendors',
    href: '/entities/vendors',
    label: 'Vendors',
    iconKey: 'users',
    group: 'purchasing',
    subgroup: 'vendor-records',
    requiredPermission: 'parties.read',
  },
  {
    key: 'inventory',
    href: '/inventory',
    label: 'Inventory',
    iconKey: 'package',
    group: 'operations',
    subgroup: 'catalog',
    requiredPermission: 'items.read',
  },
  {
    key: 'purchase-orders',
    href: '/purchase-orders',
    label: 'Purchase Orders',
    iconKey: 'clipboard',
    group: 'purchasing',
    subgroup: 'buy',
    requiredPermission: 'ap.read',
  },
  {
    key: 'ap',
    href: '/ap',
    label: 'Accounts Payable',
    iconKey: 'gauge',
    group: 'purchasing',
    subgroup: 'buy',
    requiredPermission: 'ap.read',
    exact: true,
  },
  {
    key: 'ap-bills',
    href: '/ap/bills',
    label: 'Bills',
    iconKey: 'clipboard',
    group: 'purchasing',
    subgroup: 'buy',
    requiredPermission: 'ap.read',
  },
  {
    key: 'payments',
    href: '/payments',
    label: 'Vendor Payments',
    iconKey: 'check',
    group: 'purchasing',
    subgroup: 'pay',
    requiredPermission: 'ap.pay',
  },
  {
    key: 'expenses',
    href: '/expenses/reports',
    label: 'Expenses',
    iconKey: 'scroll',
    group: 'purchasing',
    subgroup: 'pay',
    requiredPermission: 'expenses.read',
  },

  // Banking — the bank feed, matching, and reconciliation.
  {
    key: 'banking',
    href: '/banking',
    label: 'Bank Accounts',
    iconKey: 'building',
    group: 'banking',
    subgroup: 'accounts-cash',
    requiredPermission: 'banking.read',
    exact: true,
  },
  {
    key: 'banking-cash',
    href: '/banking/cash',
    label: 'Cash Position',
    iconKey: 'wallet',
    group: 'banking',
    subgroup: 'accounts-cash',
    requiredPermission: 'banking.read',
  },
  {
    key: 'banking-transactions',
    href: '/banking/transactions',
    label: 'Transactions',
    iconKey: 'journal',
    group: 'banking',
    subgroup: 'processing',
    requiredPermission: 'banking.read',
  },
  {
    key: 'banking-match',
    href: '/banking/match',
    label: 'Match',
    iconKey: 'list-checks',
    group: 'banking',
    subgroup: 'processing',
    requiredPermission: 'banking.reconcile',
  },
  {
    key: 'banking-recons',
    href: '/banking/reconciliations',
    label: 'Reconciliations',
    iconKey: 'check',
    group: 'banking',
    subgroup: 'processing',
    requiredPermission: 'banking.reconcile',
  },
  {
    key: 'banking-rules',
    href: '/banking/rules',
    label: 'Rules',
    iconKey: 'workflow',
    group: 'banking',
    subgroup: 'controls',
    requiredPermission: 'banking.reconcile',
  },
  {
    key: 'banking-imports',
    href: '/banking/imports',
    label: 'Import History',
    iconKey: 'database',
    group: 'banking',
    subgroup: 'controls',
    requiredPermission: 'banking.read',
  },

  // Accounting — ledger, recognition, assets, planning, compliance, and close.
  {
    key: 'journal',
    href: '/journal',
    label: 'Journals',
    iconKey: 'journal',
    group: 'accounting',
    subgroup: 'ledger',
    requiredPermission: 'gl.read',
  },
  {
    key: 'accounts',
    href: '/accounts',
    label: 'Chart of Accounts',
    iconKey: 'layers',
    group: 'accounting',
    subgroup: 'ledger',
    requiredPermission: 'gl.read',
  },
  {
    key: 'assets',
    href: '/assets',
    label: 'Fixed Assets',
    iconKey: 'building',
    group: 'accounting',
    subgroup: 'assets',
    requiredPermission: 'assets.read',
  },
  {
    key: 'equipment',
    href: '/assets/equipment',
    label: 'Equipment',
    iconKey: 'truck',
    group: 'operations',
    subgroup: 'catalog',
    requiredPermission: 'assets.read',
  },
  {
    key: 'tax-depreciation',
    href: '/assets/tax-pools',
    label: 'Tax Depreciation',
    iconKey: 'receipt',
    group: 'accounting',
    subgroup: 'assets',
    requiredPermission: 'assets.read',
  },
  {
    key: 'budgets',
    href: '/budgets',
    label: 'Budgets',
    iconKey: 'target',
    group: 'accounting',
    subgroup: 'planning-compliance',
    requiredPermission: 'budgets.read',
  },
  {
    key: 'tax-filings',
    href: '/tax',
    label: 'Tax Filings',
    iconKey: 'receipt',
    group: 'accounting',
    subgroup: 'planning-compliance',
    requiredPermission: 'reports.read',
  },
  {
    key: 'continuous-close',
    href: '/continuous-close',
    label: 'Close Monitor',
    iconKey: 'activity',
    group: 'accounting',
    subgroup: 'close',
    requiredPermission: 'assistant.use',
  },
  {
    key: 'close',
    href: '/close',
    label: 'Period Close',
    iconKey: 'timer',
    group: 'accounting',
    subgroup: 'close',
    requiredPermission: 'close.read',
  },

  // Operations — delivery, catalog, equipment, and people. The unified party directory
  // (/parties) is intentionally NOT in the nav: parties are an internal
  // abstraction; end users only see role-scoped views (Customers, Vendors,
  // Employees).
  {
    key: 'projects',
    href: '/projects',
    label: 'Projects',
    iconKey: 'timer',
    group: 'operations',
    subgroup: 'delivery',
    requiredPermission: 'projects.read',
  },
  {
    key: 'construction-billing',
    href: '/construction',
    label: 'Progress Billing',
    iconKey: 'clipboard-check',
    group: 'operations',
    subgroup: 'delivery',
    requiredPermission: 'ar.read',
  },
  {
    key: 'employees',
    href: '/entities/employees',
    label: 'Employees',
    iconKey: 'clipboard-check',
    group: 'operations',
    subgroup: 'people',
    requiredPermission: 'parties.read',
  },
  {
    key: 'timesheets',
    href: '/timesheets',
    label: 'Timesheets',
    iconKey: 'timer',
    group: 'operations',
    subgroup: 'delivery',
    requiredPermission: 'time.read',
  },
  {
    key: 'field-tickets',
    href: '/field-tickets',
    label: 'Field Tickets',
    iconKey: 'clipboard',
    group: 'operations',
    subgroup: 'delivery',
    requiredPermission: 'time.read',
    featureKey: 'fieldTickets',
  },

  // Insights — reports, native analytics, custom dashboards, and saved views.
  {
    key: 'reports',
    href: '/reports',
    label: 'Reports',
    iconKey: 'file',
    group: 'insights',
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
    group: 'insights',
    requiredPermission: 'reports.read',
  },
  {
    key: 'insights',
    href: '/insights',
    label: 'Dashboards',
    iconKey: 'sparkles',
    group: 'insights',
    requiredPermission: 'insights.read',
  },
  {
    key: 'saved-searches',
    href: '/knowledge/views',
    label: 'Saved Views',
    iconKey: 'search',
    group: 'insights',
    requiredPermission: 'reports.read',
  },

  // Settings — organization setup, administration, customization, automation,
  // and extension tools. Documentation and installed apps are lifted into the
  // shell utility bar by AppShell, while their stable modules remain here for
  // permissions, mobile resolution, and tenant customization.
  //
  // The Admin Center entry's gating is intentionally left unset here and handled
  // specially in the nav resolver (see ADMIN_MODULE_KEY): it appears for anyone
  // holding any admin-ish permission, and the landing page re-gates each card.
  // Every other entry uses a normal permission gate.
  {
    key: 'admin',
    href: '/admin',
    label: 'Administration',
    iconKey: 'settings',
    group: 'settings',
    subgroup: 'organization',
    exact: true,
  },
  // Documentation — the in-app help center. No permission gate: available to
  // every signed-in user (source platform-help style), linked under Administration.
  {
    key: 'docs',
    href: '/docs',
    label: 'Documentation',
    iconKey: 'book',
    group: 'settings',
  },
  {
    key: 'admin-setup',
    href: '/admin/setup',
    label: 'Company Setup',
    iconKey: 'wrench',
    group: 'settings',
    subgroup: 'organization',
    requiredPermission: 'admin.setup.manage',
  },

  // Customization, automation, and extension tools remain distinct so users do
  // not need to understand the implementation boundary between them.
  {
    key: 'records',
    href: '/records/types',
    label: 'Custom Records',
    iconKey: 'grid',
    group: 'settings',
    subgroup: 'customize',
    requiredPermission: 'records.manage_types',
  },
  {
    key: 'admin-custom-fields',
    href: '/admin/custom-fields',
    label: 'Custom Fields',
    iconKey: 'tag',
    group: 'settings',
    subgroup: 'customize',
    requiredPermission: 'admin.custom_fields.manage',
  },
  {
    key: 'admin-customization',
    href: '/admin/customization',
    label: 'Forms & Views',
    iconKey: 'panel-left',
    group: 'settings',
    subgroup: 'customize',
    requiredPermission: 'admin.customization.manage',
  },
  {
    key: 'admin-pdf-templates',
    href: '/admin/pdf-templates',
    label: 'PDF Templates',
    iconKey: 'scroll',
    group: 'settings',
    subgroup: 'customize',
    requiredPermission: 'admin.customization.manage',
  },
  {
    key: 'admin-scripts',
    href: '/admin/scripts',
    label: 'Scripts',
    iconKey: 'code',
    group: 'settings',
    subgroup: 'automate',
    requiredPermission: 'scripts.manage',
  },
  {
    key: 'flows',
    href: '/admin/flows',
    label: 'Flows',
    iconKey: 'workflow',
    group: 'settings',
    subgroup: 'automate',
    requiredPermission: 'flows.manage',
  },
  {
    key: 'admin-apps',
    href: '/admin/apps',
    label: 'App Builder',
    iconKey: 'library',
    group: 'settings',
    subgroup: 'extend',
    requiredPermission: 'apps.manage',
  },
  {
    key: 'sql',
    href: '/query',
    label: 'Query Console',
    iconKey: 'database',
    group: 'settings',
    subgroup: 'extend',
    requiredPermission: 'sql.execute',
  },
  {
    key: 'admin-api-keys',
    href: '/admin/api-keys',
    label: 'API Keys',
    iconKey: 'key',
    group: 'settings',
    subgroup: 'extend',
    requiredPermission: 'api.keys.manage',
  },
  {
    key: 'api-docs',
    href: '/api-docs',
    label: 'API Docs',
    iconKey: 'code',
    group: 'settings',
    subgroup: 'extend',
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
  customize: { href: '/admin/build', iconKey: 'construction' },
}

export const MODULE_BY_KEY = new Map(NAV_MODULES.map((m) => [m.key, m]))

/** Canonical scan order inside each workspace. Kept separate from the module
 * declarations so the information architecture is reviewable in one place. */
export const DEFAULT_NAV_ORDER: Record<NavGroupKey, readonly string[]> = {
  'my-work': ['dashboard', 'approvals', 'assistant', 'documents', 'apps'],
  customers: [
    'customers',
    'crm-leads',
    'crm-prospects',
    'crm-activities',
    'crm-opportunities',
    'crm-forecasts',
    'estimates',
    'sales-orders',
    'ar',
    'ar-invoices',
    'receipts',
  ],
  purchasing: ['purchase-orders', 'ap', 'ap-bills', 'payments', 'expenses', 'vendors'],
  operations: ['projects', 'timesheets', 'field-tickets', 'items', 'inventory', 'equipment', 'employees'],
  banking: [
    'banking',
    'banking-cash',
    'banking-transactions',
    'banking-match',
    'banking-recons',
    'banking-rules',
    'banking-imports',
  ],
  accounting: [
    'accounts',
    'journal',
    'revenue',
    'assets',
    'tax-depreciation',
    'budgets',
    'tax-filings',
    'continuous-close',
    'close',
  ],
  insights: ['reports', 'analytics', 'insights', 'saved-searches'],
  settings: [
    'admin-setup',
    'admin',
    'docs',
    'records',
    'admin-custom-fields',
    'admin-customization',
    'admin-pdf-templates',
    'flows',
    'admin-scripts',
    'admin-apps',
    'sql',
    'admin-api-keys',
    'api-docs',
  ],
}

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
    items: DEFAULT_NAV_ORDER[group.key].map((moduleKey) => ({
      kind: 'module' as const,
      moduleKey,
      ...(mobileModules.has(moduleKey) ? { mobile: true } : {}),
    })),
  }))
  return { version: 2, groups }
}
