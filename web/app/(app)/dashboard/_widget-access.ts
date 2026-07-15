import { can, type Authz } from '@/lib/authz'
import { permissionSetCovers } from '@/lib/permissions'
import { WIDGETS } from './_widget-registry'

const GL = ['gl.read']
const AP = ['ap.read', 'ap.approve']
const PARTIES = ['parties.read']
const INSIGHTS = ['insights.read', 'reports.read']

const WIDGET_PERMISSIONS: Record<string, readonly string[]> = {
  'kpi-journal-entries': GL,
  'kpi-journal-lines': GL,
  'kpi-accounts-active': GL,
  'kpi-entries-today': GL,
  'kpi-ledger-balance': GL,
  'kpi-parties': PARTIES,
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
  return canSeeInsightCards(authz)
}

/**
 * Whether insight-card widgets (UUID ids) are visible to this user. Any code
 * that persists layouts must use the same check, or a save round-trip would
 * silently drop cards the user can see (see saveDashboardLayout).
 */
export function canSeeInsightCards(authz: Authz): boolean {
  return hasAnyPermission(authz.permissions, INSIGHTS)
}

export function canSeeOrgAggregates(authz: Authz): boolean {
  return [...GL, ...AP, ...PARTIES, ...INSIGHTS].some((p) => can(authz, p))
}
