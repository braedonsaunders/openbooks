import { LOCAL_NAVIGATION, type LocalNavigationPreferences } from './local-navigation.ts'

// OpenBooks module registry. Module keys
// are STABLE ids (never change them once shipped); org nav configs reference
// them. The resolver merges this with the org's saved layout and filters by
// permission.

export type NavRecordTarget =
  | { kind: 'query'; param: string }
  | { kind: 'nested'; segment: string }
  | { kind: 'project-transaction' }

export interface NavModule {
  key: string
  href: string
  label: string
  iconKey: string
  /** Permission required to see the module (wildcards supported). */
  requiredPermission?: string
  /** Alternate grants accepted by the destination. */
  requiredPermissionsAny?: readonly string[]
  /** Additional grants that must all be held for a cross-module workspace. */
  requiredPermissionsAll?: readonly string[]
  /** Optional-feature gate — hidden while the org has the feature off. */
  featureKey?: string
  /** Every listed feature must also be enabled for this destination. */
  requiredFeatures?: readonly string[]
  /** HR-15: when set, the shell renders a live count badge on this entry,
   *  polled from this route (which must self-scope to the actor). */
  badgeCountHref?: string
  /** How a native list opens one of its records. Transaction links derive
   *  their path from this module-owned contract instead of copying routes. */
  recordTarget?: NavRecordTarget
  /** Stable default workspace key used when no org config exists. */
  group: NavGroupKey
  /** Optional nested section within the group — rendered as a collapsible
   *  sub-menu in the desktop sidebar. Flat consumers (mobile, top nav) ignore
   *  it and render the item inline. */
  subgroup?: string
  exact?: boolean
  /** The workspace header owns this landing link in its default group. */
  homeOnly?: boolean
  /** Registered entry-point key; company placements can promote this view. */
  menuParent?: string
  /** Supporting work remains accessible inside its module, outside the main menu. */
  localOnly?: boolean
}

export const NAV_GROUPS = [
  { key: 'my-work', label: 'My Work', iconKey: 'gauge' },
  { key: 'customers', label: 'Customers', iconKey: 'users' },
  { key: 'purchasing', label: 'Purchasing', iconKey: 'clipboard' },
  { key: 'operations', label: 'Operations', iconKey: 'package' },
  { key: 'hrm', label: 'People', iconKey: 'users' },
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
  hrm: '/hrm',
  insights: '/analytics',
  settings: '/admin',
}

// Nav taxonomy: stable workspaces for related business tasks. Customer work follows
// the complete relationship-to-cash journey; purchasing follows buy-to-pay;
// operations owns delivery/catalog; People owns HR; accounting owns financial control.
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
  // HR-15 begin: Inbox is core — every leader lands here. Unpermissioned
  // by design (like notifications): every query self-scopes to the actor.
  // The module key stays `approvals` (identifiers are stable); only the
  // place label (catalog) and target changed. The /inbox route stays
  // as a permanent redirect for deep links.
  {
    key: 'approvals',
    href: '/inbox',
    label: 'Inbox',
    iconKey: 'inbox',
    group: 'my-work',
    badgeCountHref: '/api/inbox?count=1',
  },
  // HR-15 end
  // HR-15 rebrand: the notifications NAV ENTRY is removed — My Work shows
  // one Inbox entry and notices surface as its Notices filter. The
  // /notifications ROUTE, page, and API stay (deep links, hrefs, the scope
  // test's query pins), reachable directly but no longer a nav module.
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
  //
  // There is ONE account destination (`customers`, below): leads, prospects
  // and customers are lifecycle stages of the same record, segmented on that
  // one list, not three nav entries pointing at three copies of the same
  // page. Pulse is a tab of the account record and has no nav entry at all.
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
    label: 'Forecasts',
    iconKey: 'target',
    group: 'customers',
    subgroup: 'pipeline',
    requiredPermission: 'crm.forecasts.read',
  },

  { key: 'crm-sales', href: '/crm/sales', label: 'Overview', iconKey: 'users', group: 'customers', subgroup: 'crm-sales', requiredPermissionsAny: ['crm.setup.manage', 'crm.forecasts.read'] },

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
    key: 'pre-billing',
    href: '/projects/pre-billing',
    label: 'Pre-billing',
    iconKey: 'clipboard-check',
    group: 'customers',
    subgroup: 'sell-collect',
    requiredPermission: 'projects.read',
    featureKey: 'preBilling',
  },
  {
    key: 'estimates',
    href: '/estimates',
    label: 'Estimates',
    iconKey: 'file',
    group: 'customers',
    subgroup: 'sell-collect',
    requiredPermission: 'ar.read',
    featureKey: 'orders',
    recordTarget: { kind: 'query', param: 'estimate' },
  },
  {
    key: 'sales-orders',
    href: '/sales-orders',
    label: 'Sales Orders',
    iconKey: 'clipboard-check',
    group: 'customers',
    subgroup: 'sell-collect',
    requiredPermission: 'ar.read',
    featureKey: 'orders',
    recordTarget: { kind: 'query', param: 'order' },
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
    key: 'stored-value',
    href: '/stored-value',
    label: 'Stored value',
    iconKey: 'gift',
    group: 'customers',
    subgroup: 'sell-collect',
    requiredPermission: 'stored_value.read',
    featureKey: 'storedValue',
    recordTarget: { kind: 'query', param: 'account' },
  },
  {
    key: 'ar-invoices',
    href: '/ar/invoices',
    label: 'Invoices',
    iconKey: 'clipboard-check',
    group: 'customers',
    subgroup: 'sell-collect',
    requiredPermission: 'ar.read',
    recordTarget: { kind: 'query', param: 'doc' },
  },
  {
    key: 'cash-sales',
    href: '/cash-sales',
    label: 'Cash Sales',
    iconKey: 'banknote',
    group: 'customers',
    subgroup: 'sell-collect',
    requiredPermission: 'cash_sales.read',
    featureKey: 'cashSales',
    recordTarget: { kind: 'query', param: 'doc' },
  },
  {
    key: 'receipts',
    href: '/receipts',
    label: 'Customer Payments',
    iconKey: 'check',
    group: 'customers',
    subgroup: 'sell-collect',
    requiredPermission: 'ar.pay',
    recordTarget: { kind: 'query', param: 'payment' },
  },
  {
    key: 'channels',
    href: '/channels',
    label: 'Channels',
    iconKey: 'layers',
    group: 'customers',
    subgroup: 'sell-collect',
    requiredPermission: 'channels.read',
    featureKey: 'salesChannels',
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
    featureKey: 'revenueRecognition',
  },
  {
    key: 'contract-costs',
    href: '/revenue/contract-costs',
    label: 'Contract Costs',
    iconKey: 'trending-up',
    group: 'accounting',
    subgroup: 'revenue-accounting',
    requiredPermission: 'contract_costs.read',
    featureKey: 'contractCosts',
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
    key: 'manufacturing', href: '/manufacturing', label: 'Manufacturing', iconKey: 'package', group: 'operations', subgroup: 'delivery',
    requiredPermission: 'manufacturing.read', featureKey: 'manufacturing', exact: true,
  },

  {
    key:'manufacturing-time', href:'/manufacturing/time', label:'Production time', iconKey:'clock',group:'operations',subgroup:'manufacturing',
    requiredPermission:'time.read',requiredPermissionsAll:['manufacturing.read'],featureKey:'manufacturing',menuParent:'manufacturing',exact:true,
  },
  {
    key:'manufacturing-quality',href:'/manufacturing/quality',label:'Quality',iconKey:'clipboard',group:'operations',subgroup:'manufacturing',
    requiredPermission:'manufacturing.read',requiredPermissionsAll:['items.read'],featureKey:'manufacturing',menuParent:'manufacturing',recordTarget:{kind:'query',param:'inspection'},exact:true,
  },
  ...([
    ['work-orders','Work orders','clipboard'],['work-centers','Work centers','settings'],
    ['routings','Routings & revisions','workflow'],['mrp','MRP runs','calendar-days'],
  ] as const).map(([route,label,iconKey]):NavModule=>({
    key:'manufacturing-'+route,href:'/manufacturing/'+route,label,iconKey,group:'operations',subgroup:'manufacturing',
    requiredPermission:'manufacturing.read',featureKey:route==='mrp'?'manufacturingMrp':'manufacturing',
    recordTarget:{kind:'query',param:'record'},menuParent:'manufacturing',exact:true,
  })),
  {
    key: 'warehouses',
    href: '/warehouse',
    label: 'Warehouses',
    iconKey: 'package',
    group: 'operations',
    subgroup: 'delivery',
    requiredPermission: 'items.read',
    featureKey: 'warehousing',
  },
  {
    key: 'picks',
    href: '/picks',
    label: 'Pick Lists',
    iconKey: 'list-checks',
    group: 'operations',
    subgroup: 'delivery',
    requiredPermission: 'orders.fulfill',
    featureKey: 'fulfillment',
    recordTarget: { kind: 'query', param: 'pick' },
  },
  {
    key: 'shipments',
    href: '/shipments',
    label: 'Shipments',
    iconKey: 'truck',
    group: 'operations',
    subgroup: 'delivery',
    requiredPermission: 'orders.fulfill',
    featureKey: 'fulfillment',
    recordTarget: { kind: 'query', param: 'shipment' },
  },
  {
    key: 'returns',
    href: '/returns',
    label: 'Returns',
    iconKey: 'rotate-ccw',
    group: 'operations',
    subgroup: 'delivery',
    requiredPermission: 'orders.fulfill',
    featureKey: 'returnAuthorizations',
    recordTarget: { kind: 'query', param: 'doc' },
  },
  {
    key: 'property-management',
    href: '/property-management',
    label: 'Property Management',
    iconKey: 'building',
    group: 'operations',
    subgroup: 'delivery',
    requiredPermission: 'ar.read',
    featureKey: 'propertyManagement',
  },
  {
    key: 'purchase-orders',
    href: '/purchase-orders',
    label: 'Purchase Orders',
    iconKey: 'clipboard',
    group: 'purchasing',
    subgroup: 'buy',
    requiredPermission: 'purchase_orders.read',
    featureKey: 'orders',
    recordTarget: { kind: 'query', param: 'order' },
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
    key: 'subcontracts',
    href: '/subcontracts',
    label: 'Subcontracts',
    iconKey: 'clipboard-check',
    group: 'purchasing',
    subgroup: 'buy',
    requiredPermission: 'ap.read',
    featureKey: 'subcontracts',
  },
  {
    key: 'ap-bills',
    href: '/ap/bills',
    label: 'Bills',
    iconKey: 'clipboard',
    group: 'purchasing',
    subgroup: 'buy',
    requiredPermission: 'ap.read',
    recordTarget: { kind: 'query', param: 'doc' },
  },
  {
    key: 'payments',
    href: '/payments',
    label: 'Vendor Payments',
    iconKey: 'check',
    group: 'purchasing',
    subgroup: 'pay',
    requiredPermission: 'ap.pay',
    recordTarget: { kind: 'query', param: 'payment' },
  },
  {
    key: 'contractor-withholding',
    href: '/contractor-withholding',
    label: 'Contractor Withholding',
    iconKey: 'receipt',
    group: 'purchasing',
    subgroup: 'pay',
    requiredPermission: 'ap.read',
    featureKey: 'contractorWithholding',
    recordTarget: { kind: 'query', param: 'return' },
  },
  {
    key: 'expenses',
    href: '/expenses/reports',
    label: 'Expenses',
    iconKey: 'scroll',
    group: 'purchasing',
    subgroup: 'pay',
    requiredPermission: 'expenses.read',
    featureKey: 'expenses',
    recordTarget: { kind: 'query', param: 'expense' },
  },

  // Purchasing → Compliance. Subcontractor compliance is a BUY-SIDE control: it
  // decides whether a payee's money may be released, so it belongs beside the
  // pay run rather than under Projects. `lien-waivers` is listed on BOTH the
  // subcontractorCompliance and projects feature gates, so it disappears when
  // either is off — a lien is a claim against a project, and there is no waiving
  // one without projects.
  {
    key: 'compliance',
    href: '/compliance',
    label: 'Compliance',
    iconKey: 'shield',
    group: 'purchasing',
    subgroup: 'compliance',
    requiredPermission: 'compliance.read',
    featureKey: 'subcontractorCompliance',
    exact: true,
  },
  {
    key: 'compliance-vendors',
    href: '/compliance/vendors',
    label: 'Subcontractors',
    iconKey: 'list-checks',
    group: 'purchasing',
    subgroup: 'compliance',
    requiredPermission: 'compliance.read',
    featureKey: 'subcontractorCompliance',
  },
  {
    key: 'lien-waivers',
    href: '/compliance/lien-waivers',
    label: 'Lien Waivers',
    iconKey: 'clipboard-check',
    group: 'purchasing',
    subgroup: 'compliance',
    requiredPermission: 'compliance.read',
    featureKey: 'subcontractorCompliance',
  },
  {
    key: 'information-returns',
    href: '/compliance/information-returns',
    label: 'Information Returns',
    iconKey: 'receipt',
    group: 'purchasing',
    subgroup: 'compliance',
    requiredPermission: 'compliance.read',
    featureKey: 'subcontractorCompliance',
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
    featureKey: 'banking',
    recordTarget: { kind: 'query', param: 'doc' },
  },
  {
    key: 'banking-psp-settlements',
    href: '/banking/psp-settlements',
    label: 'PSP settlements',
    iconKey: 'receipt',
    group: 'banking',
    subgroup: 'processing',
    requiredPermission: 'banking.read',
    featureKey: 'banking',
  },
  {
    key: 'banking-payouts',
    href: '/banking/payouts',
    label: 'Payouts',
    iconKey: 'receipt',
    group: 'banking',
    subgroup: 'processing',
    requiredPermission: 'banking.read',
    featureKey: 'banking',
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
    recordTarget: { kind: 'query', param: 'entry' },
  },
  {
    key: 'internal-billing',
    href: '/internal-billing',
    label: 'Internal Billing',
    iconKey: 'split',
    group: 'accounting',
    subgroup: 'ledger',
    requiredPermission: 'gl.read',
    featureKey: 'internalBilling',
    recordTarget: { kind: 'query', param: 'doc' },
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
    key: 'leases', href: '/assets/leases', label: 'Lessee Leases', iconKey: 'building',
    group: 'accounting', subgroup: 'assets', requiredPermission: 'assets.read',
  },
  {
    // Subsequent-measurement register (lease/asset/revenue/consolidation).
    // Not ASC 250 / IAS 8. Sits with Period Close, not Journals.
    key: 'accounting-changes', href: '/accounting/changes', label: 'Accounting events', iconKey: 'journal',
    group: 'accounting', subgroup: 'close', requiredPermission: 'gl.read',
  },
  {
    key: 'provisions', href: '/accounting/provisions', label: 'Provisions and contingencies', iconKey: 'journal',
    group: 'accounting', subgroup: 'close', requiredPermission: 'gl.read',
  },
  {
    // Nonprofit workspace home — the fund-accounting cockpit. Funds and
    // releases live as tabs on this page behind fundAccounting; the single
    // nav entry stays with the parent switch.
    key: 'nonprofit', href: '/nonprofit', label: 'Nonprofit', iconKey: 'landmark',
    group: 'accounting', requiredPermission: 'funds.read', featureKey: 'nonprofit',
  },
  {
    key: 'tax-depreciation',
    href: '/assets?tab=tax-depreciation',
    label: 'Tax Depreciation',
    iconKey: 'journal',
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
    key: 'tax-provisions',
    href: '/tax/provisions',
    label: 'Income Tax',
    iconKey: 'percent',
    group: 'accounting',
    subgroup: 'planning-compliance',
    requiredPermission: 'reports.read',
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

  // Cross-domain operational work belongs with Inbox and Assistant, not
  // inside Accounting → Close. The stable key remains `continuous-close`
  // because tenant nav configurations reference it.
  {
    key: 'continuous-close',
    href: '/agents',
    label: 'Agents',
    iconKey: 'activity',
    group: 'my-work',
    requiredPermission: 'assistant.use',
  },

  // Operations — delivery, catalog, equipment, and people. The unified party directory
  // (/parties) is intentionally NOT in the nav: parties are an internal
  // abstraction; end users only see role-scoped views (Customers, Vendors,
  // Employees).
  {
    key: 'projects',
    href: '/projects',
    label: 'Projects',
    // Not 'timer' — Timesheets sits directly below in this same subgroup and
    // owns the stopwatch; two identical icons made them indistinguishable.
    iconKey: 'hard-hat',
    group: 'operations',
    subgroup: 'delivery',
    requiredPermission: 'projects.read',
    featureKey: 'projects',
    recordTarget: { kind: 'project-transaction' },
  },
  {
    key: 'employees',
    href: '/entities/employees',
    label: 'Employees',
    iconKey: 'circle-user',
    group: 'hrm',
    subgroup: 'workforce',
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
    key: 'resourcing',
    href: '/resourcing',
    label: 'Resourcing',
    iconKey: 'users',
    group: 'operations',
    subgroup: 'delivery',
    requiredPermission: 'resourcing.read',
    featureKey: 'resourcing',
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
    recordTarget: { kind: 'query', param: 'ticket' },
  },
  {
    key: 'payroll',
    href: '/payroll',
    label: 'Overview',
    iconKey: 'wallet',
    group: 'hrm',
    subgroup: 'payroll-work',
    requiredPermission: 'payroll.read',
    featureKey: 'payroll',
    recordTarget: { kind: 'nested', segment: 'runs' },
    exact: true,
  },
  {
    key: 'hrm',
    href: '/hrm',
    label: 'Human Resources',
    iconKey: 'users',
    group: 'hrm',
    subgroup: 'workforce',
    requiredPermission: 'hrm.employment.read',
    featureKey: 'hrm',
    homeOnly: true,
    exact: true,
  },
  // Construction compliance is a feature-gated tab on the HRM strip, not
  // a second Operations → People nav module beside Payroll and Me.
  // Me — the person's own workspace (HR-9 self-service), not an HR tab:
  // employment summary, profile, leave, checklists, and the manager's
  // team. Visible with the hrm feature plus hrm.self.read, which every
  // built-in role carries; every row inside scopes by the party behind
  // the login, so the module gate is presence, never visibility.
  {
    key: 'me',
    href: '/me',
    label: 'Me',
    iconKey: 'circle-user',
    group: 'my-work',
    requiredPermission: 'hrm.self.read',
    featureKey: 'hrm',
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
    href: '/admin/setup/readiness',
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
    key: 'admin-page-layouts',
    href: '/admin/page-layouts',
    label: 'Page Layouts',
    iconKey: 'grid',
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
  // HR-16 begin: the automation recipe builder beside Flows (platform nav
  // under Flows; the automations feature gates it, exception-only approval
  // is a per-flow setting).
  {
    key: 'automations',
    href: '/admin/automations',
    label: 'Automations',
    iconKey: 'workflow',
    group: 'settings',
    subgroup: 'automate',
    requiredPermission: 'automations.read',
  },
  {
    key: 'admin-extensions',
    href: '/admin/apps',
    label: 'Apps',
    iconKey: 'package',
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
  'admin.setup.manage',
  'admin.sandboxes.manage',
  'admin.backups.manage',
  'admin.customization.manage',
  'scripts.manage',
  'flows.manage',
  // HR-16 begin
  'automations.read',
  // HR-16 end
  'apps.manage',
  'api.keys.manage',
  'sql.execute',
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

const LOCAL_DESTINATION_LABELS: Record<string, string> = {
  "/entities/employees": "Employees",
  "/hrm/org-chart": "Org chart",
  "/hrm/processes": "Processes",
  "/hrm/processes/templates": "Checklist templates",
  "/hrm/documents": "Documents",
  "/hrm/qualifications": "Qualifications",
  "/hrm/positions": "Positions",
  "/hrm/recruiting": "Openings",
  "/hrm/recruiting?tab=interviews": "Interviews",
  "/hrm/recruiting?tab=offers": "Offers",
  "/hrm/recruiting?tab=postings": "Job postings",
  "/hrm/recruiting?tab=pools": "Talent pools",
  "/hrm/leave?view=calendar": "Leave calendar",
  "/hrm/performance?tab=calibration": "Calibration",
  "/hrm/performance?tab=talent": "Assessments",
  "/hrm/performance?tab=succession": "Succession plans",
  "/hrm/performance/templates": "Review forms",
  "/hrm/performance?tab=retention": "Retention",
  "/hrm/performance?tab=settings": "Performance settings",
  "/hrm/leave": "Leave requests",
  "/hrm/performance": "Cycles",
  "/hrm/surveys": "Surveys",
  "/hrm/compensation": "Compensation",
  "/hrm/compensation/equity": "Pay equity",
  "/hrm/benefits": "Overview",
  "/hrm/benefits?view=programs": "Programs",
  "/hrm/benefits?view=employees": "Benefits",
  "/hrm/benefits?view=delivery": "Delivery",
  "/payroll": "Overview",
  "/payroll/runs": "Pay runs",
  "/payroll/anomalies": "Checks",
  "/payroll/remittances": "Remittances",
  "/payroll/separations": "Separations",
  "/payroll/year-end": "Year-end",
  "/resourcing": "Overview",
  "/resourcing/board": "Staffing board",
  "/resourcing/assignments": "Assignments",
  "/resourcing/requests": "Resource requests",
  "/resourcing/demand": "Staffing demand",
  "/resourcing/retainers": "Retainers",
  "/warehouse": "Warehouse",
  "/picks": "Pick Lists",
  "/shipments": "Shipments",
  "/returns": "Returns",
  "/nonprofit": "Nonprofit",
  "/nonprofit/funds": "Funds",
  "/nonprofit/releases": "Releases",
  "/nonprofit/grants": "Grants",
  "/nonprofit/encumbrances": "Encumbrances",
  "/nonprofit/setup": "Nonprofit setup",
  "/assets": "Fixed Assets",
  "/assets?tab=tax-depreciation": "Tax Depreciation",
  "/assets/leases": "Lessee Leases",
  "/assets/equipment": "Equipment",
  "/compliance": "Overview",
  "/compliance/vendors": "Subcontractors",
  "/compliance/lien-waivers": "Lien Waivers",
  "/compliance/information-returns": "Information Returns"
}

/** Register explicit destinations before deriving missing local destinations. */
NAV_MODULES.push(
  ...[
    ['payroll-opening-balances', '/payroll/opening-balances', 'Opening Balances', 'payroll.read', 'book'],
    ['payroll-retro', '/payroll/retro', 'Retroactive Pay', 'payroll.read', 'history'],
    ['payroll-parallel-run', '/payroll/parallel-run', 'Parallel Run', 'payroll.read', 'split'],
    ['payroll-work-locations', '/payroll/work-locations', 'Work Locations', 'payroll.manage', 'pin'],
  ].map(([key, href, label, requiredPermission, iconKey]) => ({
    key: key!, href: href!, label: label!, requiredPermission: requiredPermission!, iconKey: iconKey!, group: 'hrm' as const, subgroup: 'payroll-controls', featureKey: 'payroll', exact: true,
    // Go-live tools stay on the Payroll strip; they are not everyday menu destinations.
    ...(key === 'payroll-opening-balances' || key === 'payroll-parallel-run' ? { menuParent: 'payroll' } : {}),
  })),
  { key: 'hrm-performance-settings', href: '/hrm/performance?tab=settings', label: 'Performance setup', iconKey: 'settings', group: 'hrm', subgroup: 'hrm-talent', requiredPermission: 'hrm.performance.manage', featureKey: 'hrmPerformance', menuParent: 'hrm-performance', exact: true },
  // One workspace for every board: people boards need Scheduling, task boards Project Scheduling.
  { key: 'scheduling', href: '/scheduling', label: 'Scheduling', iconKey: 'calendar-range', group: 'hrm', subgroup: 'scheduling', requiredPermissionsAny: ['hrm.shifts.read', 'projects.read'], featureKey: 'hrmShiftPlanning', exact: true },
  { key: 'hrm-change-requests', href: '/hrm/change-requests', label: 'Employment Changes', iconKey: 'user-cog', group: 'hrm', subgroup: 'workforce', requiredPermission: 'hrm.employment.read', featureKey: 'hrm' },
  { key: 'hrm-compliance', href: '/hrm/compliance', label: 'Workforce Compliance', iconKey: 'hard-hat', group: 'hrm', subgroup: 'workforce', requiredPermission: 'hrm.construction.read', featureKey: 'hrmConstructionCompliance' },
  { key: 'admin-navigation', href: '/admin/navigation', label: 'Navigation', iconKey: 'panel-left', group: 'settings', subgroup: 'customize', requiredPermissionsAny: ['admin.nav.manage', 'admin.customization.manage'] },
  // Clocking in is a person's own daily action, so the clock lives in My
  // Work beside Me rather than inside the Operations time workspace. It
  // stays a Time tab too; time.clock grants it without time.read.
  { key: 'time-clock', href: '/time/clock', label: 'Clock', iconKey: 'timer', group: 'my-work', requiredPermission: 'time.clock', featureKey: 'fieldTime', exact: true },
)

/** Native local destinations are also discoverable and editable in the main menu. */
for (const workspace of LOCAL_NAVIGATION) {
  if (workspace.inline) continue
  // Derived pages share the registered entry point's workspace ownership.
  const entryPointGroup = NAV_MODULES.find((module) => module.href === workspace.tabs[0]?.href)?.group
  for (const tab of workspace.tabs) {
    if ((tab.href.includes('?') && !tab.menuKey) || NAV_MODULES.some((module) => module.href === tab.href)) continue
    const group: NavGroupKey = entryPointGroup ?? (workspace.id.startsWith('hrm-') || workspace.id === 'payroll'
      ? 'hrm' : workspace.id === 'resourcing' || workspace.id === 'warehouse' || workspace.id === 'time' ? 'operations'
      : workspace.id === 'compliance' ? 'purchasing' : 'accounting')
    const moduleKey = tab.menuKey ?? tab.href.slice(1).replaceAll('/', '-')
    NAV_MODULES.push({
      key: moduleKey, href: tab.href, label: tab.label ?? LOCAL_DESTINATION_LABELS[tab.href]!,
      iconKey: tab.iconKey ?? 'list-checks', group,
      subgroup: workspace.id === 'hrm-people' ? 'workforce' : workspace.id === 'hrm-hiring' ? 'hrm-talent' : workspace.id.startsWith('hrm-') ? workspace.id : workspace.id === 'payroll' ? 'payroll-work' : workspace.id,
      requiredPermission: tab.permission, requiredPermissionsAny: tab.permissionsAny, requiredPermissionsAll: tab.permissionsAll, featureKey: tab.feature ?? workspace.feature, requiredFeatures: tab.requiredFeatures,
      exact: true,
      ...(tab.menuParent ? { menuParent: tab.menuParent } : {}),
    })
  }
}

for (const module of NAV_MODULES) {
  if (['hrm-change-requests', 'hrm-processes', 'hrm-compensation-plans', 'payroll-anomalies', 'payroll-separations'].includes(module.key)) {
    module.localOnly = true
  }
}

export const MODULE_BY_KEY = new Map(NAV_MODULES.map((m) => [m.key, m]))

/**
 * Module roots that agent packs hand-built before resolving through this
 * registry (e.g. "/ar/cockpit" shipped in collections findings and 404d).
 * Findings persist their evidence hrefs, so old rows carry these paths
 * forever — they resolve at render time instead of via a backfill.
 */
export const LEGACY_MODULE_HREFS: Record<string, string> = {
  "/ar/cockpit": "ar",
};

/**
 * Resolve a STORED evidence href through the registry. Legacy module roots
 * map to the module's live href; every other string passes through
 * untouched (deep links included); non-hrefs resolve to null.
 */
export function resolveStoredHref(stored: unknown): string | null {
  if (typeof stored !== "string" || !stored.startsWith("/")) return null;
  const path = stored.split("?")[0]!;
  const legacyKey = LEGACY_MODULE_HREFS[stored] ?? LEGACY_MODULE_HREFS[path];
  if (!legacyKey) return stored;
  return MODULE_BY_KEY.get(legacyKey)?.href ?? stored;
}

/** Canonical scan order puts daily work before supporting and setup pages.
 * Kept separate from module declarations; saved company orders remain authoritative. */
export const DEFAULT_NAV_ORDER: Record<NavGroupKey, readonly string[]> = {
  // HR-15: one My Work entry (Inbox); /notifications stays a route and a
  // Notices filter inside the inbox, but no longer a nav entry.
  'my-work': ['dashboard', 'approvals', 'me', 'time-clock', 'assistant', 'continuous-close', 'documents', 'apps'],
  customers: [
    'customers',
    'crm-activities',
    'crm-opportunities',
    'crm-forecasts',
    'crm-sales',
    'crm-sales-representatives',
    'crm-sales-teams',
    'crm-sales-quotas',
    'crm-sales-territories',
    'pre-billing',
    'ar-invoices',
    'cash-sales',
    'sales-orders',
    'estimates',
    'receipts',
    'channels',
    'collections',
    'ar',
  ],
  purchasing: ['purchase-orders', 'ap-bills', 'subcontracts', 'ap', 'payments', 'expenses', 'vendors', 'compliance', 'compliance-vendors', 'lien-waivers', 'information-returns'],
  operations: [
    'projects',
    'timesheets',
    'field-tickets',
    'resourcing',
    'property-management',
    'inventory',
    'items',
    'warehouses',
    'manufacturing',
    'manufacturing-work-orders',
    'manufacturing-work-centers',
    'manufacturing-routings',
    'manufacturing-mrp',
    'manufacturing-time',
    'manufacturing-quality',
    'picks',
    'shipments',
    'returns',
    'equipment',
  ],
  hrm: [
    'hrm', 'employees', 'hrm-org-chart', 'hrm-positions', 'hrm-change-requests', 'hrm-processes', 'hrm-documents',
    'hrm-qualifications', 'hrm-training', 'hrm-compliance', 'hrm-processes-templates',
    'hrm-recruiting', 'hrm-recruiting-interviews', 'hrm-recruiting-offers',
    'hrm-recruiting-postings', 'hrm-recruiting-pools', 'hrm-leave', 'hrm-leave-calendar', 'scheduling',
    'hrm-performance', 'hrm-performance-templates', 'hrm-performance-calibration',
    'hrm-performance-talent', 'hrm-performance-succession', 'hrm-performance-retention',
    'hrm-surveys', 'hrm-performance-settings', 'hrm-compensation', 'hrm-compensation-equity',
    'hrm-benefits', 'hrm-benefits-programs', 'hrm-benefits-employees', 'hrm-benefits-delivery',
    'payroll', 'payroll-runs', 'payroll-anomalies', 'payroll-remittances',
    'payroll-separations', 'payroll-year-end',
    'payroll-retro', 'payroll-work-locations', 'payroll-parallel-run', 'payroll-opening-balances',
  ],
  banking: [
    'banking-cash',
    'banking',
    'banking-rules',
    'banking-imports',
    'banking-transactions',
    'banking-match',
    'banking-recons',
    'banking-psp-settlements',
  ],
  accounting: [
    'journal',
    'accounts',
    'revenue',
    'assets',
    'leases',
    'tax-depreciation',
    'budgets',
    'tax-filings',
    'tax-provisions',
    'close',
    'accounting-changes',
    'provisions',
    'nonprofit',
    // Within the ledger section, after Journals and Chart of Accounts.
    'internal-billing',
  ],
  insights: ['reports', 'analytics', 'insights', 'saved-searches'],
  settings: [
    'admin',
    'admin-setup',
    'docs',
    'admin-customization',
    'admin-pdf-templates',
    'admin-custom-fields',
    'admin-page-layouts',
    'admin-navigation',
    'records',
    // HR-16 begin
    'automations',
    // HR-16 end
    'flows',
    'admin-scripts',
    'admin-extensions',
    'admin-api-keys',
    'api-docs',
    'sql',
  ],
}

for (const module of NAV_MODULES) {
  if (!DEFAULT_NAV_ORDER[module.group].includes(module.key)) {
    DEFAULT_NAV_ORDER[module.group] = [...DEFAULT_NAV_ORDER[module.group], module.key]
  }
}

// --- org config shape (stored in org_nav_configs.config) -------------------

export type NavItemConfig =
  | {
      kind: 'module'
      moduleKey: string
      /** Explicit placement must survive future default workspace changes. */
      placement?: 'custom'
      label?: string
      iconKey?: string
      hidden?: boolean
      mobile?: boolean
    }
  | {
      /** First-class installed app shortcut. Resolved against the org's live
       * app catalog so disabled/uninstalled apps never become stale links. */
      kind: 'app'
      appKey: string
      label?: string
      iconKey?: string
      hidden?: boolean
      mobile?: boolean
    }
  | {
      kind: 'link'
      extensionKey?: string
      requiredPermission?: string
      href: string
      label: string
      iconKey?: string
      hidden?: boolean
      mobile?: boolean
      /** ISO timestamp stamped when the extension retire loop hid this row.
       * Absent on rows retired before the stamp existed; those sort oldest. */
      retiredAt?: string
    }

export interface NavGroupConfig {
  id: string
  label: string
  items: NavItemConfig[]
}

export interface OrgNavConfig {
  version: 2
  /** Marks the workspace defaults used when this configuration was saved. */
  architectureVersion?: 1
  localNavigation?: LocalNavigationPreferences
  groups: NavGroupConfig[]
}

export type NavAppOption = {
  key: string
  name: string
  iconKey: string
};

/** Default layout computed from the registry (used when no org config). */
export function defaultNavConfig(): OrgNavConfig {
  const mobileModules = new Set(['dashboard', 'approvals', 'ar', 'ap'])
  const groups: NavGroupConfig[] = NAV_GROUPS.map((group) => ({
    id: group.key,
    label: group.label,
    items: DEFAULT_NAV_ORDER[group.key].filter(moduleKey => !MODULE_BY_KEY.get(moduleKey)?.localOnly).map((moduleKey) => ({
      kind: 'module' as const,
      moduleKey,
      ...(mobileModules.has(moduleKey) ? { mobile: true } : {}),
    })),
  }))
  return { version: 2, architectureVersion: 1, groups }
}
