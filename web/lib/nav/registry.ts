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
  // Re-enable when the insights module lands (agent in flight):
  // { key: 'insights', href: '/insights', label: 'Insights', iconKey: 'sparkles', group: 'Overview', requiredPermission: 'insights.read' },

  { key: 'ap', href: '/ap', label: 'Payables', iconKey: 'clipboard', group: 'Money out', requiredPermission: 'ap.read' },
  { key: 'payments', href: '/payments', label: 'Payments', iconKey: 'check', group: 'Money out', requiredPermission: 'ap.pay' },
  { key: 'expenses', href: '/expenses', label: 'Expenses', iconKey: 'scroll', group: 'Money out', requiredPermission: 'expenses.read' },

  { key: 'ar', href: '/ar', label: 'Receivables', iconKey: 'clipboard-check', group: 'Money in', requiredPermission: 'ar.read' },
  { key: 'receipts', href: '/receipts', label: 'Receipts', iconKey: 'check', group: 'Money in', requiredPermission: 'ar.pay' },

  { key: 'journal', href: '/journal', label: 'Journal', iconKey: 'journal', group: 'Ledger', requiredPermission: 'gl.read' },
  { key: 'accounts', href: '/accounts', label: 'Chart of Accounts', iconKey: 'layers', group: 'Ledger', requiredPermission: 'gl.read' },
  { key: 'parties', href: '/parties', label: 'Parties', iconKey: 'users', group: 'Ledger', requiredPermission: 'parties.read' },
  { key: 'banking', href: '/banking', label: 'Banking', iconKey: 'building', group: 'Ledger', requiredPermission: 'banking.read' },
  { key: 'close', href: '/close', label: 'Period Close', iconKey: 'timer', group: 'Ledger', requiredPermission: 'gl.close' },

  { key: 'reports', href: '/reports', label: 'Reports', iconKey: 'file', group: 'Insight', requiredPermission: 'reports.read' },
  // Re-enable when the reports-engine module lands (agent in flight):
  // { key: 'custom-reports', href: '/reports/custom', label: 'Custom Reports', iconKey: 'scroll', group: 'Insight', requiredPermission: 'reports.read' },
  { key: 'sql', href: '/query', label: 'SQL', iconKey: 'database', group: 'Insight', requiredPermission: 'sql.execute' },

  { key: 'apps', href: '/apps', label: 'Apps', iconKey: 'grid', group: 'Build', requiredPermission: 'forms.read' },
  { key: 'records', href: '/records/types', label: 'Record Types', iconKey: 'grid', group: 'Build', requiredPermission: 'records.manage_types' },

  { key: 'sync', href: '/sync', label: 'Sync', iconKey: 'link', group: 'System', requiredPermission: 'sync.run' },
  { key: 'admin-users', href: '/admin/users', label: 'Users', iconKey: 'users', group: 'System', requiredPermission: 'admin.users.manage' },
  { key: 'admin-roles', href: '/admin/roles', label: 'Roles', iconKey: 'shield', group: 'System', requiredPermission: 'admin.roles.manage' },
  { key: 'admin-nav', href: '/admin/navigation', label: 'Navigation', iconKey: 'panel-left', group: 'System', requiredPermission: 'admin.nav.manage' },
  { key: 'admin-custom-fields', href: '/admin/custom-fields', label: 'Custom Fields', iconKey: 'tag', group: 'System', requiredPermission: 'admin.custom_fields.manage' },
  { key: 'admin-scripts', href: '/admin/scripts', label: 'Scripts', iconKey: 'workflow', group: 'System', requiredPermission: 'scripts.manage' },
  { key: 'admin-audit', href: '/admin/audit', label: 'Audit Log', iconKey: 'scroll', group: 'System', requiredPermission: 'admin.audit.read' },
]

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
