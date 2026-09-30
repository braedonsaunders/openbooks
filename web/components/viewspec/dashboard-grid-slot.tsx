import 'server-only'

import { getAuthz } from '../../lib/authz'
import { loadDashboardLayout } from '../../app/(app)/dashboard/_load-layout'
import { canSeeWidget } from '../../app/(app)/dashboard/_widget-access'
import { packDefaultLayout } from '../../app/(app)/dashboard/_default-layout'
import { WIDGETS } from '../../app/(app)/dashboard/_widget-registry'
import { resolveAllowedWidgetIds } from '../../app/(app)/dashboard/widget-features'
import { loadDashboardView } from '../../app/(app)/dashboard/_edit-canvas'
import { saveQuickActions } from '../../app/(app)/dashboard/actions'
import { DashboardGrid } from '../../app/(app)/dashboard/_dashboard-grid'

/**
 * Slot for the home dashboard's tile grid.
 *
 * `DashboardGrid` needs three things a spec must never carry: a
 * `Record<string, ReactNode>` of rendered tiles (component references), a
 * bound `saveQuickActions` server action (a capability), and a layout derived
 * from the caller's own permissions. So none of it travels — the slot
 * re-derives every piece from the session, and the spec places the slot with
 * no props at all.
 *
 * That is stricter than it may look. A spec is data; data that carries a
 * bound server action is an authority handed to whoever can name the block,
 * and a tenant- or agent-authored spec is exactly that. The `record-list-slot`
 * rule applies unchanged: the loader owns data, the HOST owns capabilities.
 *
 * The work below is copied verbatim from `page.tsx`: layout resolution (user
 * row → role row → tier default), the feature-aware allowed-id filter, and
 * the stale-node prune. That last one matters — removed or disabled apps and
 * unpublished insight cards leave no live node, and keeping their references
 * would render a count of things the reader cannot see. A count is a
 * disclosure. Customization can still surface and remove them on the next
 * save.
 *
 * The allowed set is resolved once here and handed to the canvas loader, so
 * the pruned layout, the rendered nodes, and the metric queries all enforce
 * the same ids. Registry ids resolve through that set; insight-card UUIDs
 * and app tiles carry no single feature key and keep canSeeWidget.
 */
export async function DashboardGridSlot() {
  const authz = await getAuthz()
  if (!authz) return null

  const { layout, role, hiddenQuickActionIds, isSystemDefault } = await loadDashboardLayout(authz)
  const allowedWidgetIds = await resolveAllowedWidgetIds(authz)
  const defaultActionsVisible = layout.quickActions?.some((action) => !hiddenQuickActionIds.includes(action.id)) !== false
  const widgets = layout.widgets.filter((widget) => !isSystemDefault || widget.id !== 'personal-actions' || defaultActionsVisible).filter((w) =>
    w.id in WIDGETS ? allowedWidgetIds.has(w.id) : canSeeWidget(authz, w.id),
  )
  const visibleLayout = { ...layout, widgets }

  const { nodes } = await loadDashboardView(authz, visibleLayout, allowedWidgetIds)
  const renderedLayout = {
    ...visibleLayout,
    widgets: visibleLayout.widgets.filter((widget) => nodes[widget.id] !== undefined),
  }

  return (
    <DashboardGrid
      initialLayout={isSystemDefault ? packDefaultLayout(renderedLayout) : renderedLayout}
      nodes={nodes}
      role={role}
      mode="view"
      quickActionsSaveAction={saveQuickActions}
      hiddenQuickActionIds={hiddenQuickActionIds}
    />
  )
}
