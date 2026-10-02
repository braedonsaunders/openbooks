/**
 * Local navigation describes related working surfaces, never a second copy of
 * an application's main menu. Stable hrefs identify destinations in saved
 * organization preferences; permission and feature metadata remain product-owned.
 */
export type LocalNavigationTab = {
  href: string
  ns: string
  key: string
  label?: string
  /** Semantic icon inherited by the native main-menu destination. */
  iconKey?: string
  /** Explicit main-menu identity for a query-addressed working view. */
  menuKey?: string
  /** Registered entry-point key; detailed views stay local unless promoted. */
  menuParent?: string
  permission?: string
  permissionsAny?: string[]
  feature?: string
  prefix?: boolean
  carry?: string[]
}

export type LocalNavigationSet = {
  id: string
  label: string
  feature?: string
  /** Inline view switches retain page-owned counts and conditional choices. */
  inline?: boolean
  tabs: LocalNavigationTab[]
}

/** Presentation preferences cannot alter route ownership or authorization. */
export type LocalNavigationPreference = {
  items: { href: string; label?: string; hidden?: boolean }[]
}

export type LocalNavigationPreferences = Record<string, LocalNavigationPreference>

export function applyLocalNavigationPreferences<T extends { href: string; label: string }>(
  tabs: readonly T[],
  preference?: LocalNavigationPreference,
): T[] {
  if (!preference) return [...tabs]
  const byHref = new Map(tabs.map((tab) => [tab.href, tab]))
  const configured = new Set<string>()
  const result: T[] = []
  for (const item of preference.items) {
    if (configured.has(item.href)) continue
    configured.add(item.href)
    const tab = byHref.get(item.href)
    if (tab && !item.hidden) result.push({ ...tab, label: item.label?.trim() || tab.label })
  }
  // New destinations inherit their product defaults rather than disappearing
  // from companies whose navigation was configured before they shipped.
  return [...result, ...tabs.filter((tab) => !configured.has(tab.href))]
}

export const HRM_LOCAL_NAVIGATION: Record<'people' | 'hiring' | 'timeOff' | 'talent' | 'compensation' | 'rewards', LocalNavigationTab[]> = {
  people: [
    { href: '/entities/employees', ns: 'nav', key: 'modules.employees', permission: 'parties.read' },
    { href: '/hrm/org-chart', iconKey: 'network', ns: 'hrm', key: 'home.tabs.orgChart', permissionsAny: ['hrm.org_chart.read', 'hrm.employment.read', 'hrm.self.read'] },
    { href: '/hrm/processes', iconKey: 'workflow', ns: 'hrm', key: 'processes.title', permission: 'hrm.process.read', prefix: true },
    { href: '/hrm/processes/templates', iconKey: 'clipboard-check', ns: 'hrm', key: 'processes.templates.title', permission: 'hrm.process.manage', prefix: true },
    { href: '/hrm/documents', iconKey: 'files', ns: 'hrm', key: 'home.tabs.documents', permission: 'hrm.documents.read', feature: 'hrmDocuments' },
    { href: '/hrm/qualifications', iconKey: 'badge-check', ns: 'hrm', key: 'home.tabs.qualifications', permission: 'hrm.certifications.read', feature: 'hrmCertifications' },
  ],
  hiring: [
    { href: '/hrm/recruiting', iconKey: 'user-search', ns: 'hrm', key: 'recruiting.tabs.openings', permission: 'hrm.recruiting.read', feature: 'hrmRecruiting', carry: ['status'] },
    { href: '/hrm/positions', iconKey: 'briefcase-business', ns: 'hrm', key: 'home.tabs.positions', permission: 'hrm.position.read', menuParent: 'hrm-recruiting' },
    ...([['interviews', 'messages-square'], ['offers', 'handshake'], ['postings', 'megaphone'], ['pools', 'users']] as const).map(([tab, iconKey]) => ({
      href: `/hrm/recruiting?tab=${tab}`, iconKey, menuKey: `hrm-recruiting-${tab}`, ns: 'hrm', key: `recruiting.tabs.${tab}`,
      menuParent: 'hrm-recruiting',
      permission: 'hrm.recruiting.read', feature: 'hrmRecruiting', carry: ['status'],
    })),
  ],
  timeOff: [
    { href: '/hrm/leave', iconKey: 'calendar-days', ns: 'hrm', key: 'leave.listTitle', permission: 'hrm.leave.read', carry: ['segment'] },
    { href: '/hrm/leave?view=calendar', iconKey: 'calendar-clock', menuKey: 'hrm-leave-calendar', ns: 'hrm', key: 'leave.calendarTitle', permission: 'hrm.leave.read', carry: ['segment'] },
  ],
  talent: [
    { href: '/hrm/performance', iconKey: 'chart-no-axes-combined', ns: 'hrm', key: 'performance.continuous.tabs.cycles', feature: 'hrmPerformance' },
    { href: '/hrm/performance/templates', iconKey: 'journal', menuKey: 'hrm-performance-templates', ns: 'hrm', key: 'performance.workspace.reviewFormsTab', permission: 'admin.setup.manage', feature: 'hrmPerformance', menuParent: 'hrm-performance', prefix: true },
    { href: '/hrm/performance?tab=calibration', iconKey: 'sliders-horizontal', menuKey: 'hrm-performance-calibration', ns: 'hrm', key: 'performance.continuous.tabs.calibration', permission: 'hrm.performance.manage', feature: 'hrmPerformance', menuParent: 'hrm-performance' },
    { href: '/hrm/performance?tab=talent', iconKey: 'chart-scatter', menuKey: 'hrm-performance-talent', ns: 'hrm', key: 'performance.workspace.assessments', permission: 'hrm.performance.manage', feature: 'hrmPerformance', menuParent: 'hrm-performance' },
    { href: '/hrm/performance?tab=succession', iconKey: 'git-branch', menuKey: 'hrm-performance-succession', ns: 'hrm', key: 'performance.workspace.succession', permission: 'hrm.performance.manage', feature: 'hrmPerformance', menuParent: 'hrm-performance' },
    { href: '/hrm/performance?tab=retention', iconKey: 'heart-pulse', menuKey: 'hrm-performance-retention', ns: 'hrm', key: 'retention.title', permission: 'hrm.retention.read', feature: 'hrmPerformance', menuParent: 'hrm-performance' },
    { href: '/hrm/surveys', iconKey: 'message', ns: 'hrm', key: 'home.tabs.surveys', permission: 'hrm.surveys.manage', feature: 'hrmSurveys', menuParent: 'hrm-performance' },
  ],
  compensation: [
    { href: '/hrm/compensation', iconKey: 'coins', ns: 'hrm', key: 'home.tabs.compensation', permission: 'hrm.compensation.read', feature: 'hrmCompensation', prefix: true },
    { href: '/hrm/compensation/equity', iconKey: 'scale', ns: 'hrm', key: 'equity.title', permission: 'hrm.compensation.read', feature: 'hrmCompensation' },
  ],
  // Keep the stored workspace identity so existing navigation preferences
  // survive the broader Benefits portfolio and its new destinations.
  rewards: [
    { href: '/hrm/benefits', iconKey: 'gift', ns: 'hrm', key: 'benefits.workspace.tabs.overview', permission: 'hrm.benefits.read' },
    { href: '/hrm/benefits?view=programs', iconKey: 'heart-handshake', menuKey: 'hrm-benefits-programs', ns: 'hrm', key: 'benefits.workspace.tabs.programs', permission: 'hrm.benefits.read' },
    { href: '/hrm/benefits?view=enrolments', iconKey: 'user-check', menuKey: 'hrm-benefits-enrolments', ns: 'hrm', key: 'benefits.workspace.tabs.enrollments', permission: 'hrm.benefits.read' },
    { href: '/hrm/benefits?view=rewards', iconKey: 'award', menuKey: 'hrm-benefits-rewards', ns: 'hrm', key: 'benefits.workspace.tabs.rewards', permission: 'hrm.benefits.read' },
    { href: '/hrm/benefits?view=incentives', iconKey: 'sparkles', menuKey: 'hrm-benefits-incentives', ns: 'hrm', key: 'benefits.workspace.tabs.incentives', permission: 'hrm.benefits.read' },
    { href: '/hrm/benefits?view=payouts', iconKey: 'banknote-arrow-up', menuKey: 'hrm-benefits-payouts', ns: 'hrm', key: 'benefits.workspace.tabs.payouts', permission: 'hrm.benefits.read' },
  ],
}

export const LOCAL_NAVIGATION: LocalNavigationSet[] = [
  { id: 'collections-views', label: 'Collections', tabs: [
    { href: '/collections', ns: 'ar', key: 'collections.tabs.worklist', permission: 'documents.manage', permissionsAny: ['ar.read'] },
    { href: '/collections?view=policies', ns: 'ar', key: 'collections.tabs.policies', permission: 'documents.manage' },
    { href: '/collections?view=recurring', ns: 'ar', key: 'collections.tabs.recurring', permission: 'documents.manage' },
    ...['subscriptions', 'plans'].map((view) => ({ href: `/collections?view=${view}`, ns: 'ar', key: `collections.tabs.${view}`, permission: 'documents.manage', permissionsAny: ['ar.read'], feature: 'subscriptionBilling' })),
    ...['versions', 'contracts', 'amendments'].map((view) => ({ href: `/collections?view=${view}`, ns: 'ar', key: `collections.tabs.${view}`, permission: 'documents.manage', permissionsAny: ['ar.read'], feature: 'advancedSubscriptions' })),
  ] },
  { id: 'crm-sales', label: 'Sales', feature: 'salesManagement', tabs: [
    ...['overview', 'representatives', 'teams', 'quotas', 'territories'].map((tab) => ({ href: tab==='overview'?'/crm/sales':`/crm/sales/${tab}`, ns: 'crm', key: `sales.tabs.${tab}`, permissionsAny: ['crm.setup.manage', 'crm.forecasts.read'], carry: ['periodStart', 'periodEnd'] })),
  ] },
  ...Object.entries(HRM_LOCAL_NAVIGATION).map(([id, tabs]) => ({ id: `hrm-${id}`, label: ({ people: 'Employees', hiring: 'Hiring', timeOff: 'Time Off', talent: 'Talent', compensation: 'Compensation', rewards: 'Benefits' } as Record<string, string>)[id]!, feature: 'hrm', tabs })),
  { id: 'time', label: 'Time', feature: 'timeTracking', tabs: [
    { href: '/timesheets', ns: 'timesheets', key: 'field.timesheetsTab', label: 'Timesheets', permission: 'time.read' },
    { href: '/time/clock', ns: 'timesheets', key: 'field.clockTab', label: 'Time Clock', permission: 'time.clock', feature: 'fieldTime' },
    { href: '/time/crew', ns: 'timesheets', key: 'field.crewTab', label: 'Crew Time', permissionsAny: ['time.read', 'time.enter'], feature: 'fieldTime' },
  ] },
  { id: 'tax-views', label: 'Tax', inline: true, tabs: [
    { href: '/tax', ns: 'tax', key: 'tabs.prepare' },
    { href: '/tax?tab=history', ns: 'tax', key: 'tabs.history' },
  ] },
  { id: 'close-views', label: 'Continuous Close', inline: true, tabs: [
    { href: '/continuous-close', ns: 'continuousClose', key: 'tabs.findings' },
    { href: '/continuous-close?tab=reports', ns: 'continuousClose', key: 'tabs.reports' },
  ] },
  { id: 'insights-views', label: 'Insights', inline: true, tabs: [
    { href: '/insights', ns: 'insights', key: 'tabs.cards' },
    { href: '/insights/dashboards', ns: 'insights', key: 'tabs.dashboards' },
  ] },
  { id: 'setup-allocations', label: 'Allocations', inline: true, tabs: [
    { href: '/admin/setup/allocations?tab=rules', ns: 'allocations', key: 'rules.tabs.rules' },
    { href: '/admin/setup/allocations?tab=drivers', ns: 'allocations', key: 'rules.tabs.drivers' },
    { href: '/admin/setup/allocations?tab=runs', ns: 'allocations', key: 'rules.tabs.runs' },
  ] },
  { id: 'setup-depreciation', label: 'Depreciation', inline: true, tabs: [
    { href: '/admin/setup/depreciation?tab=methods', ns: 'admin', key: 'setup.assetDepreciationSetup.tabs.methods' },
    { href: '/admin/setup/depreciation?tab=books', ns: 'admin', key: 'setup.assetDepreciationSetup.tabs.books' },
  ] },
  { id: 'setup-tax-depreciation', label: 'Tax Depreciation', inline: true, tabs: [
    { href: '/admin/setup/tax-depreciation?tab=overview', ns: 'admin', key: 'setup.taxDepreciationSetup.tabs.overview' },
    { href: '/admin/setup/tax-depreciation?tab=regimes', ns: 'admin', key: 'setup.taxDepreciationSetup.tabs.regimes' },
  ] },
  { id: 'setup-overhead', label: 'Overhead', inline: true, tabs: [
    { href: '/admin/setup/overhead?view=model', ns: 'admin', key: 'setup.entities.overhead-model.tabs.model' },
    { href: '/admin/setup/overhead?view=rates', ns: 'admin', key: 'setup.entities.overhead-model.tabs.rates' },
    { href: '/admin/setup/overhead?view=lifecycle', ns: 'admin', key: 'setup.entities.overhead-model.tabs.lifecycle' },
    { href: '/admin/setup/overhead?view=application', ns: 'admin', key: 'setup.entities.overhead-model.tabs.application' },
  ] },
  { id: 'setup-payments', label: 'Payment Operations', inline: true, tabs: [
    { href: '/admin/setup/payment-operations?view=profiles', ns: 'admin', key: 'setup.paymentOperations.tabs.profiles' },
    { href: '/admin/setup/payment-operations?view=formats', ns: 'admin', key: 'setup.paymentOperations.tabs.formats' },
    { href: '/admin/setup/payment-operations?view=schedules', ns: 'admin', key: 'setup.paymentOperations.tabs.schedules' },
    { href: '/admin/setup/payment-operations?view=mandates', ns: 'admin', key: 'setup.paymentOperations.tabs.mandates' },
  ] },
  { id: 'journal-views', label: 'Journals', inline: true, tabs: [
    { href: '/journal', ns: 'journal', key: 'list.entriesTab' },
    { href: '/journal?journalTab=drafts', ns: 'journal', key: 'list.draftsTab' },
  ] },
  { id: 'accounts-views', label: 'Chart of Accounts', inline: true, tabs: [
    { href: '/accounts', ns: 'accounts', key: 'list.views.list' },
    { href: '/accounts?layout=hierarchy', ns: 'accounts', key: 'list.views.hierarchy' },
  ] },
  { id: 'inventory-views', label: 'Inventory', inline: true, tabs: [
    ...['onhand', 'movements', 'counts', 'locations', 'bom'].map((view) => ({ href: `/inventory?inventoryView=${view}`, ns: 'inventory', key: `view.${view}` })),
  ] },
  { id: 'inbox-views', label: 'Inbox', inline: true, tabs: [
    { href: '/inbox', ns: 'approvals', key: 'tabs.mine' },
    { href: '/inbox?tab=tasks', ns: 'inbox', key: 'filters.myTasks' },
    ...['submitted', 'all'].map((tab) => ({ href: `/inbox?tab=${tab}`, ns: 'approvals', key: `tabs.${tab}` })),
  ] },
  { id: 'me-views', label: 'Me', inline: true, tabs: [
    { href: '/me', ns: 'hrm', key: 'me.tabs.overview' },
    { href: '/hrm/my-leave', ns: 'hrm', key: 'me.tabs.leave' },
    ...['profile', 'checklists', 'reviews', 'benefits', 'team', 'compensation', 'documents'].map((tab) => ({ href: `/me/${tab}`, ns: 'hrm', key: `me.tabs.${tab}` })),
    { href: '/me/one-on-ones', ns: 'hrm', key: 'me.tabs.oneOnOnes' },
    { href: '/me/surveys', ns: 'hrm', key: 'me.tabs.openSurveys' },
  ] },
  { id: 'payroll', label: 'Payroll', feature: 'payroll', tabs: [
    { href: '/payroll', ns: 'payroll', key: 'home.tabs.overview', permission: 'payroll.read' },
    { href: '/payroll/runs', iconKey: 'circle-dollar-sign', ns: 'payroll', key: 'home.tabs.runs', permission: 'payroll.read', prefix: true },
    { href: '/payroll/anomalies', iconKey: 'shield', ns: 'payroll', key: 'home.tabs.checks', permission: 'payroll.read' },
    { href: '/payroll/remittances', iconKey: 'landmark', ns: 'payroll', key: 'home.tabs.remittances', permission: 'payroll.read' },
    { href: '/payroll/separations', iconKey: 'user-minus', ns: 'payroll', key: 'home.tabs.separations', permission: 'payroll.read' },
    { href: '/payroll/year-end', iconKey: 'calendar-check', ns: 'payroll', key: 'home.tabs.yearEnd', permission: 'payroll.read' },
    ...[
      ['opening-balances', 'payroll.read'],
      ['retro', 'payroll.read'],
      ['parallel-run', 'payroll.read'],
      ['work-locations', 'payroll.manage'],
    ].map(([route, permission]) => ({
      href: `/payroll/${route}`, ns: 'nav', key: `modules.payroll-${route}`, permission,
    })),
  ] },
  { id: 'resourcing', label: 'Resourcing', feature: 'resourcing', tabs: [
    ...[['', 'overview'], ['/board', 'board'], ['/assignments', 'assignments'], ['/requests', 'requests'], ['/demand', 'demand'], ['/retainers', 'retainers']].map(([suffix, key]) => ({
      href: `/resourcing${suffix}`, ns: 'resourcing', key: `cockpit.tabs.${key}`, permission: 'resourcing.read',
      ...(key === 'requests' ? { feature: 'resourceRequests' } : {}),
      ...(key === 'retainers' ? { feature: 'retainerBilling', permission: 'retainers.read' } : {}),
    })),
  ] },
  { id: 'warehouse', label: 'Warehouse', feature: 'warehousing', tabs: [
    { href: '/warehouse', ns: 'warehouse', key: 'home.title', permission: 'items.read' },
    { href: '/picks', ns: 'nav', key: 'modules.picks', permission: 'orders.fulfill', feature: 'fulfillment' },
    { href: '/shipments', ns: 'nav', key: 'modules.shipments', permission: 'orders.fulfill', feature: 'fulfillment' },
    { href: '/returns', ns: 'nav', key: 'modules.returns', permission: 'orders.fulfill', feature: 'returnAuthorizations' },
  ] },
  { id: 'nonprofit', label: 'Nonprofit', feature: 'nonprofit', tabs: [
    { href: '/nonprofit', ns: 'nonprofit', key: 'home.title', permission: 'funds.read' },
    { href: '/nonprofit/funds', ns: 'nonprofit', key: 'funds.title', permission: 'funds.read', feature: 'fundAccounting' },
    { href: '/nonprofit/releases', ns: 'nonprofit', key: 'releases.title', permission: 'funds.read', feature: 'fundAccounting' },
    { href: '/nonprofit/grants', ns: 'nonprofit', key: 'grants.title', permission: 'grants.read', feature: 'grantManagement' },
    { href: '/nonprofit/encumbrances', ns: 'nonprofit', key: 'encumbrances.title', permission: 'encumbrances.read', feature: 'encumbrances' },
    { href: '/nonprofit/setup', ns: 'nonprofit', key: 'setup.title', permission: 'funds.read' },
  ] },
  { id: 'assets', label: 'Fixed Assets', tabs: [
    { href: '/assets', ns: 'nav', key: 'modules.assets', permission: 'assets.read', feature: 'fixedAssets' },
    { href: '/assets?tab=tax-depreciation', ns: 'nav', key: 'modules.tax-depreciation', permission: 'assets.read', feature: 'fixedAssets' },
    { href: '/assets/leases', ns: 'nav', key: 'modules.leases', permission: 'assets.read', feature: 'fixedAssets', prefix: true },
    { href: '/assets/equipment', ns: 'nav', key: 'modules.equipment', permission: 'assets.read', feature: 'equipment' },
  ] },
  { id: 'compliance', label: 'Subcontractor Compliance', feature: 'subcontractorCompliance', tabs: [
    { href: '/compliance', ns: 'compliance', key: 'tabs.overview', permission: 'compliance.read' },
    { href: '/compliance/vendors', ns: 'compliance', key: 'tabs.vendors', permission: 'compliance.read' },
    { href: '/compliance/lien-waivers', ns: 'compliance', key: 'tabs.lienWaivers', permission: 'compliance.read', feature: 'projects' },
    { href: '/compliance/information-returns', ns: 'compliance', key: 'tabs.informationReturns', permission: 'compliance.read' },
  ] },
]

export const LOCAL_NAVIGATION_BY_ID = new Map(LOCAL_NAVIGATION.map((set) => [set.id, set]))
