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
  /** Default group label used when no org config exists. */
  group: string
  /** Optional nested section within the group — rendered as a collapsible
   *  sub-menu in the desktop sidebar. Flat consumers (mobile, top nav) ignore
   *  it and render the item inline. */
  subgroup?: string
  exact?: boolean
}

// Nav taxonomy: NetSuite-style "workflow workspaces" (Option B). Each top-level
// group is a job-to-be-done that holds BOTH its transactions and its records
// (e.g. Sales = invoices + customers). The same groups drive the left sidebar
// headers and the top-nav dropdown categories. Module keys are STABLE — only
// the `group` assignment changed when the taxonomy was reorganized.
export const NAV_MODULES: NavModule[] = [
  // Home — the daily landing surfaces.
  { key: 'dashboard', href: '/dashboard', label: 'Dashboard', iconKey: 'gauge', group: 'Home', exact: true },
  { key: 'assistant', href: '/assistant', label: 'Assistant', iconKey: 'sparkles', group: 'Home', requiredPermission: 'assistant.use' },
  { key: 'approvals', href: '/approvals', label: 'Approvals', iconKey: 'check', group: 'Home', requiredPermission: 'ap.approve' },

  // CRM — relationship lifecycle, daily activities, pipeline, and forecasts.
  { key: 'crm-leads', href: '/crm/leads', label: 'Leads', iconKey: 'users', group: 'CRM', requiredPermission: 'crm.accounts.read' },
  { key: 'crm-prospects', href: '/crm/prospects', label: 'Prospects', iconKey: 'target', group: 'CRM', requiredPermission: 'crm.accounts.read' },
  { key: 'crm-opportunities', href: '/crm/opportunities', label: 'Opportunities', iconKey: 'activity', group: 'CRM', requiredPermission: 'crm.opportunities.read' },
  { key: 'crm-activities', href: '/crm/activities', label: 'Activities', iconKey: 'timer', group: 'CRM', requiredPermission: 'crm.activities.read' },
  { key: 'crm-forecasts', href: '/crm/forecasts', label: 'Forecasts & Quotas', iconKey: 'target', group: 'CRM', requiredPermission: 'crm.forecasts.read' },

  // Purchases — money out plus the vendors it flows to.
  { key: 'purchase-orders', href: '/purchase-orders', label: 'Purchase Orders', iconKey: 'clipboard', group: 'Purchases', requiredPermission: 'ap.read' },
  { key: 'ap', href: '/ap', label: 'Bills', iconKey: 'clipboard', group: 'Purchases', requiredPermission: 'ap.read' },
  { key: 'payments', href: '/payments', label: 'Payments', iconKey: 'check', group: 'Purchases', requiredPermission: 'ap.pay' },
  { key: 'expenses', href: '/expenses', label: 'Expenses', iconKey: 'scroll', group: 'Purchases', requiredPermission: 'expenses.read' },
  { key: 'vendors', href: '/entities/vendors', label: 'Vendors', iconKey: 'users', group: 'Purchases', requiredPermission: 'parties.read' },

  // Sales — money in plus the customers it comes from.
  { key: 'estimates', href: '/estimates', label: 'Estimates', iconKey: 'file', group: 'Sales', requiredPermission: 'ar.read' },
  { key: 'sales-orders', href: '/sales-orders', label: 'Sales Orders', iconKey: 'clipboard-check', group: 'Sales', requiredPermission: 'ar.read' },
  { key: 'ar', href: '/ar', label: 'Invoices', iconKey: 'clipboard-check', group: 'Sales', requiredPermission: 'ar.read' },
  { key: 'receipts', href: '/receipts', label: 'Customer Payments', iconKey: 'check', group: 'Sales', requiredPermission: 'ar.pay' },
  { key: 'customers', href: '/entities/customers', label: 'Customers', iconKey: 'users', group: 'Sales', requiredPermission: 'parties.read' },
  { key: 'projects', href: '/projects', label: 'Projects', iconKey: 'timer', group: 'Sales', requiredPermission: 'projects.read' },
  { key: 'items', href: '/items', label: 'Items & Services', iconKey: 'grid', group: 'Sales', requiredPermission: 'items.read' },

  // Banking — the bank feed, matching, and reconciliation.
  { key: 'banking', href: '/banking', label: 'Overview', iconKey: 'building', group: 'Banking', requiredPermission: 'banking.read', exact: true },
  { key: 'banking-match', href: '/banking/match', label: 'Match Bank Data', iconKey: 'list-checks', group: 'Banking', requiredPermission: 'banking.reconcile' },
  { key: 'banking-transactions', href: '/banking/transactions', label: 'Transactions', iconKey: 'journal', group: 'Banking', requiredPermission: 'banking.read' },
  { key: 'banking-recons', href: '/banking/reconciliations', label: 'Reconciliations', iconKey: 'check', group: 'Banking', requiredPermission: 'banking.reconcile' },
  { key: 'banking-imports', href: '/banking/imports', label: 'Import History', iconKey: 'database', group: 'Banking', requiredPermission: 'banking.read' },
  { key: 'banking-rules', href: '/banking/rules', label: 'Reconciliation Rules', iconKey: 'workflow', group: 'Banking', requiredPermission: 'banking.reconcile' },

  // Accounting — the ledger core: journals, chart, assets, tax, close, and budgets.
  { key: 'journal', href: '/journal', label: 'Journals', iconKey: 'journal', group: 'Accounting', requiredPermission: 'gl.read' },
  { key: 'accounts', href: '/accounts', label: 'Chart of Accounts', iconKey: 'layers', group: 'Accounting', requiredPermission: 'gl.read' },
  { key: 'assets', href: '/assets', label: 'Fixed Assets', iconKey: 'building', group: 'Accounting', requiredPermission: 'assets.read' },
  { key: 'tax-filings', href: '/tax', label: 'Tax Filings', iconKey: 'receipt', group: 'Accounting', requiredPermission: 'reports.read' },
  { key: 'close', href: '/close', label: 'Period Close', iconKey: 'timer', group: 'Accounting', requiredPermission: 'close.read' },
  { key: 'continuous-close', href: '/continuous-close', label: 'Continuous Close', iconKey: 'activity', group: 'Accounting', requiredPermission: 'assistant.use' },
  { key: 'budgets', href: '/budgets', label: 'Budgets', iconKey: 'target', group: 'Accounting', requiredPermission: 'budgets.read' },

  // People & Time — employees and timesheets. The unified party directory
  // (/parties) is intentionally NOT in the nav: parties are an internal
  // abstraction; end users only see role-scoped views (Customers, Vendors,
  // Employees).
  { key: 'employees', href: '/entities/employees', label: 'Employees', iconKey: 'clipboard-check', group: 'People & Time', requiredPermission: 'parties.read' },
  { key: 'timesheets', href: '/timesheets', label: 'Weekly Timesheets', iconKey: 'timer', group: 'People & Time', requiredPermission: 'time.read' },

  // Reports — every read surface: statements, analytics, views, docs, queries.
  { key: 'reports', href: '/reports', label: 'Reports', iconKey: 'file', group: 'Reports', requiredPermission: 'reports.read' },
  // Analytics is ONE nav entry — the /analytics hub. The individual dashboards
  // (Financial Health, Customer Intelligence, …) are cards on the hub, not nav
  // modules (user directive 2026-07-16). No `exact` so it stays active on
  // /analytics/* sub-routes.
  { key: 'analytics', href: '/analytics', label: 'Analytics', iconKey: 'activity', group: 'Reports', requiredPermission: 'reports.read' },
  { key: 'insights', href: '/insights', label: 'Insights', iconKey: 'sparkles', group: 'Reports', requiredPermission: 'insights.read' },
  { key: 'documents', href: '/documents', label: 'Documents', iconKey: 'folder', group: 'Reports', requiredPermission: 'documents.read' },
  { key: 'saved-searches', href: '/knowledge/views', label: 'Views', iconKey: 'search', group: 'Reports', requiredPermission: 'reports.read' },
  { key: 'sql', href: '/query', label: 'Queries', iconKey: 'database', group: 'Reports', requiredPermission: 'sql.execute' },

  // Settings — the admin surfaces. Three entries: "Platform" is the /admin
  // landing hub (users, roles, navigation, audit, sync as cards); "Setup" is
  // the configuration workspace (tax, dimensions, terms, company &
  // accounting); "Build" is a nested sub-menu holding every authoring tool —
  // Custom Records, custom fields, forms & views, PDF templates, scripts,
  // apps, and the API surfaces.
  //
  // The Platform entry's gating is intentionally left unset here and handled
  // specially in the nav resolver (see ADMIN_MODULE_KEY): it appears for anyone
  // holding any admin-ish permission, and the landing page re-gates each card.
  // Every other entry uses a normal permission gate.
  { key: 'admin', href: '/admin', label: 'Platform', iconKey: 'settings', group: 'Settings', exact: true },
  { key: 'admin-setup', href: '/admin/setup', label: 'Setup', iconKey: 'wrench', group: 'Settings', requiredPermission: 'admin.setup.manage' },

  // Build — the developer/authoring tools, nested under Settings. The desktop
  // sidebar renders the subgroup as a collapsible section; the top nav renders
  // it as a flyout sub-menu. The subgroup header itself links to the
  // /admin/build landing hub (see NAV_SUBGROUPS).
  { key: 'records', href: '/records/types', label: 'Custom Records', iconKey: 'grid', group: 'Settings', subgroup: 'Build', requiredPermission: 'records.manage_types' },
  { key: 'admin-custom-fields', href: '/admin/custom-fields', label: 'Custom Fields', iconKey: 'tag', group: 'Settings', subgroup: 'Build', requiredPermission: 'admin.custom_fields.manage' },
  { key: 'admin-customization', href: '/admin/customization', label: 'Forms & Views', iconKey: 'panel-left', group: 'Settings', subgroup: 'Build', requiredPermission: 'admin.customization.manage' },
  { key: 'admin-pdf-templates', href: '/admin/pdf-templates', label: 'PDF Templates', iconKey: 'scroll', group: 'Settings', subgroup: 'Build', requiredPermission: 'admin.customization.manage' },
  { key: 'admin-scripts', href: '/admin/scripts', label: 'Scripts', iconKey: 'code', group: 'Settings', subgroup: 'Build', requiredPermission: 'scripts.manage' },
  { key: 'flows', href: '/admin/flows', label: 'Flows', iconKey: 'workflow', group: 'Settings', subgroup: 'Build', requiredPermission: 'flows.manage' },
  { key: 'admin-apps', href: '/admin/apps', label: 'Apps', iconKey: 'library', group: 'Settings', subgroup: 'Build', requiredPermission: 'apps.manage' },
  { key: 'admin-api-keys', href: '/admin/api-keys', label: 'API Keys', iconKey: 'key', group: 'Settings', subgroup: 'Build', requiredPermission: 'api.keys.manage' },
  { key: 'api-docs', href: '/api-docs', label: 'API Docs', iconKey: 'code', group: 'Settings', subgroup: 'Build', requiredPermission: 'api.keys.manage' },

  // Apps — the launcher for installed app packages. Authoring lives
  // as a card on the Platform hub (/admin/apps); this is where users run them.
  { key: 'apps', href: '/apps', label: 'Apps', iconKey: 'grid', group: 'Home', requiredPermission: 'apps.use' },
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
  | { kind: 'module'; moduleKey: string; label?: string; iconKey?: string; hidden?: boolean }
  | { kind: 'link'; href: string; label: string; iconKey?: string; hidden?: boolean }

export interface NavGroupConfig {
  id: string
  label: string
  items: NavItemConfig[]
}

export interface OrgNavConfig {
  version: 1
  groups: NavGroupConfig[]
}

/** Default layout computed from the registry (used when no org config). */
export function defaultNavConfig(): OrgNavConfig {
  const groups: NavGroupConfig[] = []
  for (const m of NAV_MODULES) {
    let g = groups.find((x) => x.label === m.group)
    if (!g) {
      g = { id: m.group.toLowerCase().replace(/\s+/g, '-'), label: m.group, items: [] }
      groups.push(g)
    }
    g.items.push({ kind: 'module', moduleKey: m.key })
  }
  return { version: 1, groups }
}
