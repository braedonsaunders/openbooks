import type { RoleTier } from './_role-tier'

export type WidgetCategory =
  | 'kpi'
  | 'gl'
  | 'ap'
  | 'ar'
  | 'personal'
  | 'admin'

export type WidgetMeta = {
  id: string
  category: WidgetCategory
  labelKey: string
  descriptionKey: string
  defaultSize: { w: number; h: number }
  minSize: { w: number; h: number }
  maxSize?: { w?: number; h?: number }
  rolesShown?: readonly RoleTier[]
}

export const WIDGETS: Record<string, WidgetMeta> = {
  'kpi-journal-lines': {
    id: 'kpi-journal-lines',
    category: 'kpi',
    labelKey: 'widgets.journalLines',
    descriptionKey: 'catalog.journalLines',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-accounts-active': {
    id: 'kpi-accounts-active',
    category: 'kpi',
    labelKey: 'widgets.activeAccounts',
    descriptionKey: 'catalog.activeAccounts',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-entries-today': {
    id: 'kpi-entries-today',
    category: 'kpi',
    labelKey: 'widgets.entriesToday',
    descriptionKey: 'catalog.entriesToday',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-pending-approvals': {
    id: 'kpi-pending-approvals',
    category: 'kpi',
    labelKey: 'widgets.pendingApprovals',
    descriptionKey: 'catalog.pendingApprovals',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
    rolesShown: ['admin', 'controller', 'approver'],
  },
  'kpi-agent-findings': {
    id: 'kpi-agent-findings',
    category: 'kpi',
    labelKey: 'widgets.agentFindings',
    descriptionKey: 'catalog.agentFindings',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-ledger-balance': {
    id: 'kpi-ledger-balance',
    category: 'kpi',
    labelKey: 'widgets.ledgerBalance',
    descriptionKey: 'catalog.ledgerBalance',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'list-recent-entries': {
    id: 'list-recent-entries',
    category: 'gl',
    labelKey: 'widgets.recentEntries',
    descriptionKey: 'catalog.recentEntries',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 4, h: 4 },
  },
  'list-pending-approvals': {
    id: 'list-pending-approvals',
    category: 'ap',
    labelKey: 'widgets.pendingApprovalsList',
    descriptionKey: 'catalog.pendingApprovalsList',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 4, h: 4 },
    rolesShown: ['admin', 'controller', 'approver'],
  },
  'personal-in-progress': {
    id: 'personal-in-progress',
    category: 'personal',
    labelKey: 'widgets.inProgress',
    descriptionKey: 'catalog.inProgress',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 3, h: 4 },
  },
  'personal-inbox': {
    id: 'personal-inbox',
    category: 'personal',
    labelKey: 'widgets.myApprovals',
    descriptionKey: 'catalog.myApprovals',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 4, h: 4 },
    rolesShown: ['admin', 'controller', 'approver'],
  },
  'personal-actions': {
    id: 'personal-actions',
    category: 'personal',
    labelKey: 'quickActions.title',
    descriptionKey: 'catalog.quickActions',
    defaultSize: { w: 12, h: 3 },
    // Four columns is the narrowest card that shows two full-width action
    // labels side by side; four rows the shortest that shows the six default
    // actions without scrolling.
    minSize: { w: 4, h: 4 },
  },
  'kpi-cash-balance': {
    id: 'kpi-cash-balance',
    category: 'kpi',
    labelKey: 'widgets.cashBalance',
    descriptionKey: 'catalog.cashBalance',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-open-receivables': {
    id: 'kpi-open-receivables',
    category: 'ar',
    labelKey: 'widgets.openReceivables',
    descriptionKey: 'catalog.openReceivables',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-overdue-receivables': {
    id: 'kpi-overdue-receivables',
    category: 'ar',
    labelKey: 'widgets.overdueReceivables',
    descriptionKey: 'catalog.overdueReceivables',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-open-payables': {
    id: 'kpi-open-payables',
    category: 'ap',
    labelKey: 'widgets.openPayables',
    descriptionKey: 'catalog.openPayables',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-overdue-payables': {
    id: 'kpi-overdue-payables',
    category: 'ap',
    labelKey: 'widgets.overduePayables',
    descriptionKey: 'catalog.overduePayables',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-revenue-mtd': {
    id: 'kpi-revenue-mtd',
    category: 'kpi',
    labelKey: 'widgets.revenue',
    descriptionKey: 'catalog.revenue',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-net-income-mtd': {
    id: 'kpi-net-income-mtd',
    category: 'kpi',
    labelKey: 'widgets.netIncome',
    descriptionKey: 'catalog.netIncome',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-gross-margin-mtd': {
    id: 'kpi-gross-margin-mtd',
    category: 'kpi',
    labelKey: 'widgets.grossMargin',
    descriptionKey: 'catalog.grossMargin',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-expected-receipts-30d': {
    id: 'kpi-expected-receipts-30d',
    category: 'ar',
    labelKey: 'widgets.expectedReceipts',
    descriptionKey: 'catalog.expectedReceipts',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-bills-due-30d': {
    id: 'kpi-bills-due-30d',
    category: 'ap',
    labelKey: 'widgets.expectedPayments',
    descriptionKey: 'catalog.expectedPayments',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'list-top-customers': {
    id: 'list-top-customers',
    category: 'ar',
    labelKey: 'widgets.topCustomers',
    descriptionKey: 'catalog.topCustomers',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 4, h: 4 },
  },
  'list-top-vendors': {
    id: 'list-top-vendors',
    category: 'ap',
    labelKey: 'widgets.topVendors',
    descriptionKey: 'catalog.topVendors',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 4, h: 4 },
  },
  'kpi-cash-runway': {
    id: 'kpi-cash-runway',
    category: 'kpi',
    labelKey: 'widgets.runway',
    descriptionKey: 'catalog.runway',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-items-to-reconcile': {
    id: 'kpi-items-to-reconcile',
    category: 'kpi',
    labelKey: 'widgets.itemsToReconcile',
    descriptionKey: 'catalog.itemsToReconcile',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
}

export const CATEGORY_LABEL_KEYS: Record<WidgetCategory, string> = {
  kpi: 'categories.kpi',
  gl: 'categories.gl',
  ap: 'categories.ap',
  ar: 'categories.ar',
  personal: 'categories.personal',
  admin: 'categories.admin',
}

export function widgetsForRole(role: RoleTier): WidgetMeta[] {
  return Object.values(WIDGETS).filter((w) => !w.rolesShown || w.rolesShown.includes(role))
}
