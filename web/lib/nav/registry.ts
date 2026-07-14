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
  exact?: boolean
}

export const NAV_MODULES: NavModule[] = [
  { key: 'dashboard', href: '/', label: 'Dashboard', iconKey: 'gauge', group: 'Overview', exact: true },
  { key: 'approvals', href: '/approvals', label: 'Approvals', iconKey: 'check', group: 'Overview', requiredPermission: 'ap.approve' },
  { key: 'insights', href: '/insights', label: 'Insights', iconKey: 'sparkles', group: 'Overview', requiredPermission: 'insights.read' },

  { key: 'ap', href: '/ap', label: 'Payables', iconKey: 'clipboard', group: 'Money out', requiredPermission: 'ap.read' },
  { key: 'payments', href: '/payments', label: 'Payments', iconKey: 'check', group: 'Money out', requiredPermission: 'ap.pay' },
  { key: 'expenses', href: '/expenses', label: 'Expenses', iconKey: 'scroll', group: 'Money out', requiredPermission: 'expenses.read' },

  { key: 'ar', href: '/ar', label: 'Receivables', iconKey: 'clipboard-check', group: 'Money in', requiredPermission: 'ar.read' },
  { key: 'receipts', href: '/receipts', label: 'Receipts', iconKey: 'check', group: 'Money in', requiredPermission: 'ar.pay' },

  // Entities — one underlying party directory, surfaced as the separate lists
  // people expect (NetSuite Relationships). Roles decide which list a party
  // appears in; a single record can be a customer AND a vendor. "All parties"
  // is the unified catch-all for cross-role records.
  { key: 'customers', href: '/entities/customers', label: 'Customers', iconKey: 'users', group: 'Entities', requiredPermission: 'parties.read' },
  { key: 'vendors', href: '/entities/vendors', label: 'Vendors', iconKey: 'clipboard', group: 'Entities', requiredPermission: 'parties.read' },
  { key: 'employees', href: '/entities/employees', label: 'Employees', iconKey: 'clipboard-check', group: 'Entities', requiredPermission: 'parties.read' },
  { key: 'parties', href: '/parties', label: 'All parties', iconKey: 'layers', group: 'Entities', requiredPermission: 'parties.read' },

  // Catalog — the item/service master that sales & purchase lines reference.
  { key: 'items', href: '/items', label: 'Items & Services', iconKey: 'grid', group: 'Catalog', requiredPermission: 'items.read' },

  { key: 'journal', href: '/journal', label: 'Journal', iconKey: 'journal', group: 'Ledger', requiredPermission: 'gl.read' },
  { key: 'accounts', href: '/accounts', label: 'Chart of Accounts', iconKey: 'layers', group: 'Ledger', requiredPermission: 'gl.read' },
  { key: 'banking', href: '/banking', label: 'Banking', iconKey: 'building', group: 'Ledger', requiredPermission: 'banking.read' },
  { key: 'close', href: '/close', label: 'Period Close', iconKey: 'timer', group: 'Ledger', requiredPermission: 'gl.close' },

  { key: 'reports', href: '/reports', label: 'Reports', iconKey: 'file', group: 'Insight', requiredPermission: 'reports.read' },
  { key: 'custom-reports', href: '/reports/custom', label: 'Custom Reports', iconKey: 'scroll', group: 'Insight', requiredPermission: 'reports.read' },
  { key: 'sql', href: '/query', label: 'SQL', iconKey: 'database', group: 'Insight', requiredPermission: 'sql.execute' },

  // Build — the customization/authoring tools
  { key: 'apps', href: '/apps', label: 'Apps', iconKey: 'grid', group: 'Build', requiredPermission: 'forms.read' },
  { key: 'records', href: '/records/types', label: 'Record Types', iconKey: 'grid', group: 'Build', requiredPermission: 'records.manage_types' },
  { key: 'admin-custom-fields', href: '/admin/custom-fields', label: 'Custom Fields', iconKey: 'tag', group: 'Build', requiredPermission: 'admin.custom_fields.manage' },
  { key: 'admin-scripts', href: '/admin/scripts', label: 'Scripts', iconKey: 'workflow', group: 'Build', requiredPermission: 'scripts.manage' },

  // Administration — a single sidebar entry into the /admin landing hub. The
  // individual surfaces (users, roles, navigation, audit, sync, company &
  // accounting settings) are reached from that landing page, not the sidebar.
  // Gating is intentionally left unset here and handled specially in the nav
  // resolver (see ADMIN_MODULE_KEY): the entry appears for anyone holding any
  // admin-ish permission, and the landing page itself re-gates each card.
  { key: 'admin', href: '/admin', label: 'Administration', iconKey: 'settings', group: 'Administration', exact: true },
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
  'admin.custom_fields.manage',
  'scripts.manage',
  'sync.run',
] as const

/** Nav module key for the collapsed Administration entry (special-cased in the resolver). */
export const ADMIN_MODULE_KEY = 'admin'

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
