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
  label: string
  description: string
  defaultSize: { w: number; h: number }
  minSize: { w: number; h: number }
  maxSize?: { w?: number; h?: number }
  rolesShown?: readonly RoleTier[]
}

export const WIDGETS: Record<string, WidgetMeta> = {
  'kpi-journal-entries': {
    id: 'kpi-journal-entries',
    category: 'kpi',
    label: 'Journal entries',
    description: 'Total posted journal entries.',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-journal-lines': {
    id: 'kpi-journal-lines',
    category: 'kpi',
    label: 'Journal lines',
    description: 'Total posted journal lines.',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-accounts-active': {
    id: 'kpi-accounts-active',
    category: 'kpi',
    label: 'Active accounts',
    description: 'Count of active accounts in the chart of accounts.',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-parties': {
    id: 'kpi-parties',
    category: 'kpi',
    label: 'Parties',
    description: 'Total parties (customers, vendors, employees).',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-entries-today': {
    id: 'kpi-entries-today',
    category: 'kpi',
    label: 'Entries today',
    description: 'Journal entries posted today.',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'kpi-pending-approvals': {
    id: 'kpi-pending-approvals',
    category: 'kpi',
    label: 'Pending approvals',
    description: 'Approval requests awaiting a decision.',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
    rolesShown: ['admin', 'controller', 'approver'],
  },
  'kpi-ledger-balance': {
    id: 'kpi-ledger-balance',
    category: 'kpi',
    label: 'Ledger balance',
    description: 'Sum of all journal line amounts — should be zero when balanced.',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 6, h: 4 },
  },
  'list-recent-entries': {
    id: 'list-recent-entries',
    category: 'gl',
    label: 'Recent journal entries',
    description: 'Last 5 posted journal entries with debits and line counts.',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 4, h: 4 },
  },
  'list-pending-approvals': {
    id: 'list-pending-approvals',
    category: 'ap',
    label: 'Pending approvals',
    description: 'Approval requests awaiting a decision, newest first.',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 4, h: 4 },
    rolesShown: ['admin', 'controller', 'approver'],
  },
  'personal-in-progress': {
    id: 'personal-in-progress',
    category: 'personal',
    label: 'In progress',
    description: 'Your draft documents — bills, invoices, journal entries — to pick up where you left off.',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 3, h: 4 },
  },
  'personal-inbox': {
    id: 'personal-inbox',
    category: 'personal',
    label: 'My approvals',
    description: 'Approval requests assigned to you.',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 4, h: 4 },
    rolesShown: ['admin', 'controller', 'approver'],
  },
  'personal-actions': {
    id: 'personal-actions',
    category: 'personal',
    label: 'Quick actions',
    description: 'Common "start something" CTAs — new bill, invoice, journal entry, etc.',
    defaultSize: { w: 12, h: 2 },
    minSize: { w: 3, h: 2 },
  },
}

export const CATEGORY_LABELS: Record<WidgetCategory, string> = {
  kpi: 'Headline',
  gl: 'General ledger',
  ap: 'Payables',
  ar: 'Receivables',
  personal: 'Personal',
  admin: 'Admin',
}

export function widgetsForRole(role: RoleTier): WidgetMeta[] {
  return Object.values(WIDGETS).filter((w) => !w.rolesShown || w.rolesShown.includes(role))
}
