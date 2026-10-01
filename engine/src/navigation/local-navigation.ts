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

export const HRM_LOCAL_NAVIGATION: Record<'people' | 'hiring' | 'timeOff' | 'talent' | 'rewards', LocalNavigationTab[]> = {
  people: [
    { href: '/entities/employees', ns: 'nav', key: 'modules.employees', permission: 'parties.read' },
    { href: '/hrm/org-chart', ns: 'hrm', key: 'home.tabs.orgChart', permissionsAny: ['hrm.employment.read', 'hrm.self.read'] },
    { href: '/hrm/processes', ns: 'hrm', key: 'home.tabs.processes', permission: 'hrm.process.read', prefix: true },
    { href: '/hrm/documents', ns: 'hrm', key: 'home.tabs.documents', permission: 'hrm.documents.read', feature: 'hrmDocuments' },
    { href: '/hrm/qualifications', ns: 'hrm', key: 'home.tabs.qualifications', permission: 'hrm.certifications.read', feature: 'hrmCertifications' },
  ],
  hiring: [
    { href: '/hrm/positions', ns: 'hrm', key: 'home.tabs.positions', permission: 'hrm.position.read' },
    { href: '/hrm/recruiting', ns: 'hrm', key: 'recruiting.tabs.openings', permission: 'hrm.recruiting.read', feature: 'hrmRecruiting', carry: ['status'] },
    ...['interviews', 'offers', 'postings', 'pools'].map((tab) => ({
      href: `/hrm/recruiting?tab=${tab}`, ns: 'hrm', key: `recruiting.tabs.${tab}`,
      permission: 'hrm.recruiting.read', feature: 'hrmRecruiting', carry: ['status'],
    })),
  ],
  timeOff: [
    { href: '/hrm/leave', ns: 'hrm', key: 'leave.listTitle', permission: 'hrm.leave.read', carry: ['segment'] },
    { href: '/hrm/leave?view=calendar', ns: 'hrm', key: 'leave.calendarTitle', permission: 'hrm.leave.read', carry: ['segment'] },
  ],
  talent: [
    { href: '/hrm/performance', ns: 'hrm', key: 'performance.continuous.tabs.cycles', feature: 'hrmPerformance' },
    ...['calibration', 'talent'].map((tab) => ({ href: `/hrm/performance?tab=${tab}`, ns: 'hrm', key: `performance.continuous.tabs.${tab}`, permission: 'hrm.performance.manage', feature: 'hrmPerformance' })),
    { href: '/hrm/performance?tab=retention', ns: 'hrm', key: 'retention.title', permission: 'hrm.retention.read', feature: 'hrmPerformance' },
    { href: '/hrm/surveys', ns: 'hrm', key: 'home.tabs.surveys', permission: 'hrm.surveys.manage', feature: 'hrmSurveys' },
    { href: '/hrm/performance?tab=settings', ns: 'hrm', key: 'performance.continuous.tabs.settings', permission: 'hrm.performance.manage', feature: 'hrmPerformance' },
  ],
  rewards: [
    { href: '/hrm/compensation', ns: 'hrm', key: 'home.tabs.compensation', permission: 'hrm.compensation.read', feature: 'hrmCompensation', prefix: true },
    { href: '/hrm/compensation/equity', ns: 'hrm', key: 'equity.title', permission: 'hrm.compensation.read', feature: 'hrmCompensation' },
    { href: '/hrm/benefits', ns: 'hrm', key: 'benefits.windowsTitle', permission: 'hrm.benefits.read' },
    { href: '/hrm/benefits?view=enrolments', ns: 'hrm', key: 'benefits.enrolmentsTitle', permission: 'hrm.benefits.read' },
  ],
}

export const LOCAL_NAVIGATION: LocalNavigationSet[] = [
  ...Object.entries(HRM_LOCAL_NAVIGATION).map(([id, tabs]) => ({ id: `hrm-${id}`, label: ({ people: 'Employees', hiring: 'Hiring', timeOff: 'Time Off', talent: 'Talent', rewards: 'Rewards' } as Record<string, string>)[id]!, feature: 'hrm', tabs })),
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
    { href: '/payroll/runs', ns: 'payroll', key: 'home.tabs.runs', permission: 'payroll.read', prefix: true },
    { href: '/payroll/anomalies', ns: 'payroll', key: 'home.tabs.checks', permission: 'payroll.read' },
    { href: '/payroll/remittances', ns: 'payroll', key: 'home.tabs.remittances', permission: 'payroll.read' },
    { href: '/payroll/separations', ns: 'payroll', key: 'home.tabs.separations', permission: 'payroll.read' },
    { href: '/payroll/year-end', ns: 'payroll', key: 'home.tabs.yearEnd', permission: 'payroll.read' },
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
