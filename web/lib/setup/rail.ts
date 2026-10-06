import { SETUP_GROUPS, setupEntitiesByGroup } from './registry'

/**
 * The Company Setup rail as data: every Setup page a reader may open, grouped
 * as the rail shows them. The rail component renders it and global search
 * offers the same entries, so a Setup page is findable exactly when its rail
 * link is visible. Labels are full message keys (namespace included) so the
 * client rail and the server search resolve them with their own translator.
 */
export type SetupRailFlags = {
  canExport: boolean
  canImport: boolean
  canManageSetup: boolean
  canManagePerformance?: boolean
  canManageCompensation?: boolean
  canReadPayrollPackages?: boolean
  canManageCrm?: boolean
  canManagePeriods?: boolean
  hiddenEntityKeys?: string[]
  projectsEnabled?: boolean
  currencyEnabled?: boolean
  fixedAssetsEnabled?: boolean
  crmEnabled?: boolean
  bankFeedsEnabled?: boolean
  onlinePaymentsEnabled?: boolean
  shippingEnabled?: boolean
  payrollEnabled?: boolean
  hrmEnabled?: boolean
}

export type SetupRailItem = { href: string; labelKey: string; iconKey: string }
export type SetupRailGroup = { key: string; labelKey: string; items: SetupRailItem[] }
export type SetupRail = { groups: SetupRailGroup[]; data: { labelKey: string; items: SetupRailItem[] } }

export function setupRail({
  canExport,
  canImport,
  canManageSetup,
  canManagePerformance = false,
  canManageCompensation = false,
  canReadPayrollPackages = false,
  canManageCrm = false,
  canManagePeriods,
  hiddenEntityKeys = [],
  projectsEnabled = true,
  currencyEnabled = true,
  fixedAssetsEnabled = true,
  crmEnabled = true,
  bankFeedsEnabled = false,
  onlinePaymentsEnabled = false,
  shippingEnabled = false,
  payrollEnabled = false,
  hrmEnabled = false,
}: SetupRailFlags): SetupRail {
  // Drop feature-gated entities (e.g. subsidiary tabs when multi-subsidiary is off).
  const hidden = new Set(hiddenEntityKeys)
  const byGroup = setupEntitiesByGroup()
  if (hidden.size) for (const [g, list] of byGroup) byGroup.set(g, list.filter((e) => !hidden.has(e.key)))
  const entities = (groupKey: string): SetupRailItem[] =>
    (byGroup.get(groupKey) ?? []).map((e) => ({
      href: `/admin/setup/${e.key}`,
      labelKey: `admin.setup.entities.${e.key}.title`,
      iconKey: e.iconKey,
    }))

  const groups: SetupRailGroup[] = []
  for (const group of SETUP_GROUPS) {
    if (!canManageSetup && group.key !== 'company' && !(group.key === 'workforce' && (canManagePerformance || canManageCompensation || canReadPayrollPackages))) continue
    const items: SetupRailItem[] =
      group.key === 'accounting'
        ? [
            ...(canManagePeriods
              ? [{ href: '/admin/setup/period-close', labelKey: 'close.setup.title', iconKey: 'calendar' }]
              : []),
            ...entities(group.key),
          ]
        : group.key === 'company'
        ? [
            { href: '/admin/setup/readiness', labelKey: 'admin.setup.readiness.navTitle', iconKey: 'gauge' },
            { href: '/admin/setup/wizard', labelKey: 'admin.setup.features.runWizard', iconKey: 'sparkles' },
            { href: '/admin/setup/company', labelKey: 'admin.setup.entities.company.title', iconKey: 'building' },
            { href: '/admin/setup/company#sample-companies', labelKey: 'data.import.sample.industry', iconKey: 'sparkles' },
            { href: '/admin/setup/features', labelKey: 'admin.setup.features.navTitle', iconKey: 'layers' },
            ...entities(group.key),
            ...(bankFeedsEnabled
              ? [{ href: '/admin/setup/bank-feeds', labelKey: 'admin.setup.bankFeeds.navTitle', iconKey: 'landmark' }]
              : []),
            ...(onlinePaymentsEnabled
              ? [{ href: '/admin/setup/payment-providers', labelKey: 'admin.setup.paymentProviders.navTitle', iconKey: 'payments' }]
              : []),
            { href: '/admin/setup/payment-operations', labelKey: 'admin.setup.entities.payment-operations.title', iconKey: 'payments' },
            ...(crmEnabled
              ? [{ href: '/admin/setup/crm', labelKey: 'crm.setup.title', iconKey: 'users' }]
              : []),
          ]
        : group.key === 'currency'
        ? [
            ...(currencyEnabled
              ? [{ href: '/admin/setup/fx-provider', labelKey: 'admin.setup.fxProvider.title', iconKey: 'coins' }]
              : []),
            ...entities(group.key),
          ]
        : group.key === 'projects'
        ? [
            ...(projectsEnabled
              ? [
                  { href: '/admin/setup/project-types', labelKey: 'projectTypes.title', iconKey: 'briefcase' },
                  { href: '/admin/setup/overhead', labelKey: 'admin.setup.entities.overhead-model.title', iconKey: 'gauge' },
                  { href: '/admin/setup/labor-costing', labelKey: 'admin.setup.laborCosting.navTitle', iconKey: 'coins' },
                  { href: '/admin/setup/labor-pricing', labelKey: 'laborPricing.navTitle', iconKey: 'tag' },
                  // Overhead rates live as a subtab of the Overhead workspace, not
                  // a standalone rail entry — filter it out of the generic group.
                  ...entities(group.key).filter((item) => item.href !== '/admin/setup/overhead-rates'),
                ]
              : []),
          ]
        : group.key === 'billing'
        ? [
            { href: '/admin/setup/invoicing', labelKey: 'admin.setup.invoicing.navTitle', iconKey: 'receipt' },
            ...entities(group.key),
          ]
        : group.key === 'taxes'
        ? [
            { href: '/admin/setup/tax-setup', labelKey: 'admin.setup.taxSetup.navTitle', iconKey: 'landmark' },
            { href: '/admin/setup/tax-provider', labelKey: 'admin.setup.taxProvider.title', iconKey: 'cloud-upload' },
            ...entities(group.key),
          ]
        : group.key === 'workforce'
        ? [
            ...(canManageCompensation ? [{ href: '/admin/setup/compensation', labelKey: 'hrm.compensation.settings.title', iconKey: 'coins' }] : []),
            ...(canManagePerformance ? [{ href: '/admin/setup/performance', labelKey: 'hrm.performance.workspace.setupTitle', iconKey: 'clipboard-list' }] : []),
            // The review-form and hiring-funnel builders: one page per
            // template/pipeline behind these index pages.
            ...(hrmEnabled
              ? [
                  { href: '/admin/setup/review-templates', labelKey: 'admin.setup.reviewBuilder.navTitle', iconKey: 'clipboard-list' },
                  { href: '/admin/setup/hiring-pipelines', labelKey: 'admin.setup.pipelineBuilder.navTitle', iconKey: 'workflow' },
                ]
              : []),
            ...entities(group.key),
            ...(payrollEnabled
              ? [{ href: '/admin/setup/payroll', labelKey: 'admin.setup.payroll.navTitle', iconKey: 'payments' }]
              : []),
          ]
        : group.key === 'inventory'
        ? [
            ...(shippingEnabled
              ? [{ href: '/admin/setup/shipping', labelKey: 'admin.setup.shipping.navTitle', iconKey: 'package' }]
              : []),
            ...entities(group.key),
          ]
        : group.key === 'assets'
        ? fixedAssetsEnabled
          ? [
              ...entities(group.key),
              { href: '/admin/setup/depreciation', labelKey: 'admin.setup.assetDepreciationSetup.navTitle', iconKey: 'percent' },
              { href: '/admin/setup/tax-depreciation', labelKey: 'admin.setup.taxDepreciationSetup.navTitle', iconKey: 'landmark' },
            ]
          : []
        : group.key === 'agents'
        ? [
            { href: '/admin/setup/agents', labelKey: 'admin.setup.agents.nav.overview', iconKey: 'sparkles' },
            { href: '/admin/setup/agents/library', labelKey: 'admin.setup.agents.nav.library', iconKey: 'book-open' },
            { href: '/admin/setup/agents/activity', labelKey: 'admin.setup.agents.nav.activity', iconKey: 'history' },
          ]
        : entities(group.key)
    const authorizedItems = group.key === 'workforce' && canReadPayrollPackages && !canManageSetup ? [...items, { href: '/admin/setup/payroll?tab=compensation-packages', labelKey: 'admin.setup.entities.payroll-compensation-packages.title', iconKey: 'coins' }] : items
    const visibleItems = canManageSetup ? authorizedItems : authorizedItems.filter((item) => (canManageCrm && item.href === '/admin/setup/crm') || (canManagePerformance && item.href === '/admin/setup/performance') || (canManageCompensation && item.href === '/admin/setup/compensation') || (canReadPayrollPackages && item.href === '/admin/setup/payroll?tab=compensation-packages'))
    if (visibleItems.length === 0) continue
    groups.push({ key: group.key, labelKey: `admin.setup.groups.${group.key}`, items: visibleItems })
  }

  const dataItems: SetupRailItem[] = [
    ...(canExport ? [{ href: '/data/export', labelKey: 'data.nav.export', iconKey: 'download' }] : []),
    ...(canImport
      ? [
          { href: '/data/import', labelKey: 'data.nav.import', iconKey: 'upload' },
          { href: '/data/import/history', labelKey: 'data.nav.history', iconKey: 'history' },
        ]
      : []),
  ]

  return { groups, data: { labelKey: 'data.nav.group', items: dataItems } }
}
