import 'server-only'

import { getAuthz } from '../../lib/authz'
import { loadDashboardLayout } from '../../app/(app)/dashboard/_load-layout'
import { packDefaultLayout } from '../../app/(app)/dashboard/_default-layout'
import { WIDGETS } from '../../app/(app)/dashboard/_widget-registry'
import { canSeeWidget } from '../../app/(app)/dashboard/_widget-access'
import { resolveAllowedWidgetIds } from '../../app/(app)/dashboard/widget-features'
import { loadDashboardEditCanvas } from '../../app/(app)/dashboard/_edit-canvas'
import { saveQuickActions } from '../../app/(app)/dashboard/actions'
import { DashboardGrid } from '../../app/(app)/dashboard/_dashboard-grid'

/**
 * Slot for the dashboard CUSTOMISE canvas — the edit-mode twin of
 * `DashboardGridSlot`.
 *
 * Same rule, and it bites harder here. This canvas needs rendered tile nodes,
 * a bound `saveQuickActions` server action, AND `allowedWidgetIds` — a
 * permission decision, computed per caller. None of the three may travel
 * through a spec: a spec is data, and data that carries a permission set is a
 * decision made somewhere a tenant-authored spec could reach. The slot
 * re-derives all of it from the session; the spec names the block and nothing
 * else.
 *
 * The remount key is derived here rather than passed, for the same reason:
 * it is a function of the layout the slot itself resolves, and threading it
 * through the spec would mean resolving that layout twice and hoping the two
 * answers match.
 *
 * Every line below is copied from `page.tsx`.
 */
export async function DashboardEditSlot() {
  const authz = await getAuthz()
  if (!authz) return null

  const { layout, role, hiddenQuickActionIds, isSystemDefault } = await loadDashboardLayout(authz)
  // One resolved set drives the pruned layout, the palette/addability, and
  // the canvas below: a feature-off tile is neither shown, offered, nor
  // rendered. Registry ids resolve through the set; insight-card UUIDs and
  // app tiles carry no single feature key and keep canSeeWidget.
  const allowedWidgetIds = await resolveAllowedWidgetIds(authz)
  const defaultActionsVisible = layout.quickActions?.some((action) => !hiddenQuickActionIds.includes(action.id)) !== false
  const filteredLayout = {
    ...layout,
    widgets: layout.widgets.filter((widget) => !isSystemDefault || widget.id !== 'personal-actions' || defaultActionsVisible).filter((w) =>
      w.id in WIDGETS ? allowedWidgetIds.has(w.id) : canSeeWidget(authz, w.id),
    ),
  }
  const visibleLayout = isSystemDefault ? packDefaultLayout(filteredLayout) : filteredLayout
  const { nodes, libraryCards, apps } = await loadDashboardEditCanvas(authz, visibleLayout, {
    allowedWidgetIds,
  })

  return (
    <DashboardGrid
      key={`${role}:${JSON.stringify(visibleLayout.widgets)}`}
      initialLayout={visibleLayout}
      nodes={nodes}
      role={role}
      mode="edit"
      libraryCards={libraryCards}
      apps={apps}
      allowedWidgetIds={[...allowedWidgetIds]}
      quickActionsSaveAction={saveQuickActions}
      hiddenQuickActionIds={hiddenQuickActionIds}
    />
  )
}
