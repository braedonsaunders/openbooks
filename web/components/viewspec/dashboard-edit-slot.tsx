import 'server-only'

import { getAuthz } from '../../lib/authz'
import { loadDashboardLayout } from '../../app/(app)/dashboard/_load-layout'
import { WIDGETS } from '../../app/(app)/dashboard/_widget-registry'
import { canSeeWidget } from '../../app/(app)/dashboard/_widget-access'
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

  const { layout, role, hiddenQuickActionIds } = await loadDashboardLayout(authz)
  const visibleLayout = {
    ...layout,
    widgets: layout.widgets.filter((w) => canSeeWidget(authz, w.id)),
  }
  const allowedWidgetIds = new Set(Object.keys(WIDGETS).filter((id) => canSeeWidget(authz, id)))
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
      allowedWidgetIds={allowedWidgetIds}
      quickActionsSaveAction={saveQuickActions}
      hiddenQuickActionIds={hiddenQuickActionIds}
    />
  )
}
