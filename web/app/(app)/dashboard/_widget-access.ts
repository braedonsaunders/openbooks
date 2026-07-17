import type { Authz } from '@/lib/authz'
import { isUuid } from '@/lib/list-params'
import { permissionSetCovers } from '@/lib/permissions'
import { WIDGETS } from './_widget-registry'

const GL = ['gl.read']
const AP = ['ap.read', 'ap.approve']
const INSIGHTS = ['insights.read', 'reports.read']

const WIDGET_PERMISSIONS: Record<string, readonly string[]> = {
  'kpi-journal-lines': GL,
  'kpi-accounts-active': GL,
  'kpi-entries-today': GL,
  'kpi-ledger-balance': GL,
  'kpi-cash-balance': GL,
  'kpi-open-receivables': ['ar.read'],
  'kpi-overdue-receivables': ['ar.read'],
  'kpi-open-payables': ['ap.read'],
  'kpi-overdue-payables': ['ap.read'],
  'kpi-pending-approvals': AP,
  'list-recent-entries': GL,
  'list-pending-approvals': AP,
  'personal-inbox': AP,
}

function hasAnyPermission(permissions: ReadonlySet<string>, required: readonly string[]): boolean {
  // Wildcard-aware, so '*' and module-level grants like 'gl.*' count.
  return required.some((p) => permissionSetCovers(permissions, p))
}

export function canSeeWidget(authz: Authz, id: string): boolean {
  const required = WIDGET_PERMISSIONS[id]
  if (required) return hasAnyPermission(authz.permissions, required)
  if (id in WIDGETS) return true
  return isUuid(id) && canSeeInsightCards(authz)
}

/**
 * Whether insight-card widgets (UUID ids) are visible to this user. Any code
 * that persists layouts must use the same check, or a save round-trip would
 * silently drop cards the user can see (see saveDashboardLayout).
 */
export function canSeeInsightCards(authz: Authz): boolean {
  return hasAnyPermission(authz.permissions, INSIGHTS)
}
