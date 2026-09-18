import type { Authz } from '@/lib/authz'
import { isUuid } from '@/lib/list-params'
import { permissionSetCovers } from '@/lib/permissions'
import { WIDGETS } from './_widget-registry'
import { isAppWidgetId } from '@/lib/apps/surfaces'

const GL = ['gl.read']
const AP = ['ap.read', 'ap.approve']
const BANKING = ['banking.read']
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
  // P&L tiles read the P&L report reader over the caller's subsidiary scope —
  // the same doorway as /reports/pnl, so the same grant guards both.
  'kpi-revenue-mtd': ['reports.read'],
  'kpi-net-income-mtd': ['reports.read'],
  'kpi-gross-margin-mtd': ['reports.read'],
  'kpi-expected-receipts-30d': ['ar.read'],
  'kpi-bills-due-30d': ['ap.read'],
  'list-top-customers': ['ar.read'],
  'list-top-vendors': ['ap.read'],
  // The runway discloses cash trajectory and burn — the banking doorway,
  // not the ledger one. A viewer holds gl.read (sees today's cash balance)
  // but not banking.read (no forecast): the stricter grant wins, so the
  // tile never shows a projection to a caller denied the cockpit.
  'kpi-cash-runway': ['banking.read'],
  'kpi-items-to-reconcile': BANKING,
  'kpi-pending-approvals': AP,
  'kpi-agent-findings': ['assistant.use'],
  'list-recent-entries': GL,
  'list-pending-approvals': AP,
  'personal-inbox': AP,
  // Deliberately public: quick-action shortcuts carry no org data, and the
  // in-progress list is scoped to the caller's own drafts (created_by =
  // self) in the loader. An empty array is an EXPLICIT open decision — the
  // registry-agreement test refuses a WIDGETS id with no entry at all, which
  // is how an ungated tile used to ship through the fallthrough below.
  'personal-in-progress': [],
  'personal-actions': [],
}

function hasAnyPermission(permissions: ReadonlySet<string>, required: readonly string[]): boolean {
  // Wildcard-aware, so '*' and module-level grants like 'gl.*' count.
  return required.some((p) => permissionSetCovers(permissions, p))
}

export function canSeeWidget(authz: Authz, id: string): boolean {
  const required = WIDGET_PERMISSIONS[id]
  // An empty entry is a reviewed public tile (see above), not a missing one.
  if (required) return required.length === 0 || hasAnyPermission(authz.permissions, required)
  if (id in WIDGETS) return true
  if (isAppWidgetId(id)) return hasAnyPermission(authz.permissions, ['apps.use'])
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
