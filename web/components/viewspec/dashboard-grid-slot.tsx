import 'server-only'

import { getAuthz } from '../../lib/authz'
import { loadDashboardLayout } from '../../app/(app)/dashboard/_load-layout'
import { canSeeWidget } from '../../app/(app)/dashboard/_widget-access'
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
 * row → role row → tier default), the `canSeeWidget` visibility filter, and
 * the stale-node prune. That last one matters — removed or disabled apps and
 * unpublished insight cards leave no live node, and keeping their references
 * would render a count of things the reader cannot see. A count is a
 * disclosure. Customization can still surface and remove them on the next
 * save.
 */
export async function DashboardGridSlot() {
  const authz = await getAuthz()
  if (!authz) return null

  const { layout, role, hiddenQuickActionIds } = await loadDashboardLayout(authz)
  const widgets = layout.widgets.filter((w) => canSeeWidget(authz, w.id))
  const visibleLayout = { ...layout, widgets }

  const { nodes } = await loadDashboardView(authz, visibleLayout)
  const renderedLayout = {
    ...visibleLayout,
    widgets: visibleLayout.widgets.filter((widget) => nodes[widget.id] !== undefined),
  }

  return (
    <DashboardGrid
      initialLayout={renderedLayout}
      nodes={nodes}
      role={role}
      mode="view"
      quickActionsSaveAction={saveQuickActions}
      hiddenQuickActionIds={hiddenQuickActionIds}
    />
  )
}
