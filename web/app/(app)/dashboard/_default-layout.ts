import type { DashboardLayoutData } from '@openbooks/schema'
import { clampToWidgetMinimums, DashboardLayoutInputSchema } from './_layout-input'
import { WIDGETS } from './_widget-registry'

export function selectStoredDashboardLayout(
  fallback: { layout: DashboardLayoutData; isSystemDefault: boolean },
  row?: { layout: unknown; is_customised: boolean },
): { layout: DashboardLayoutData; isCustomised: boolean; isSystemDefault: boolean } {
  // Uncustomized rows are snapshots, not preferences. Recompute them so
  // industry, company size, features and current defaults take effect.
  const fresh = { ...fallback, isCustomised: false }
  if (!row || !row.is_customised) return fresh
  const parsed = DashboardLayoutInputSchema.safeParse(row.layout)
  if (!parsed.success || parsed.data.widgets.length === 0) return fresh
  const quickActions = typeof row.layout === 'object' && row.layout !== null && 'quickActions' in row.layout
    ? row.layout.quickActions : undefined
  return {
    layout: {
      widgets: clampToWidgetMinimums(parsed.data.widgets),
      ...(Array.isArray(quickActions) ? { quickActions } : {}),
    },
    isCustomised: true,
    isSystemDefault: false,
  }
}

/** Reflow product defaults after visibility filtering; saved arrangements keep their coordinates. */
export function packDefaultLayout(layout: DashboardLayoutData): DashboardLayoutData {
  const widgets = clampToWidgetMinimums(layout.widgets).map((widget) => ({ ...widget }))
  let y = 0
  let row: typeof widgets = []
  const finishRow = () => {
    if (!row.length) return
    let spare = 12 - row.reduce((sum, widget) => sum + widget.w, 0)
    while (spare > 0) {
      const expandable = row.filter((widget) => widget.w < (WIDGETS[widget.id]?.maxSize?.w ?? 12))
      if (!expandable.length) break
      for (const widget of expandable) {
        if (!spare) break
        widget.w++
        spare--
      }
    }
    let x = 0
    for (const widget of row) {
      widget.x = x
      widget.y = y
      x += widget.w
    }
    y += Math.max(...row.map((widget) => widget.h))
    row = []
  }
  for (const widget of widgets) {
    if (row.length && (row[0]!.h !== widget.h || row.reduce((sum, cell) => sum + cell.w, 0) + widget.w > 12)) finishRow()
    row.push(widget)
  }
  finishRow()
  return { ...layout, widgets }
}
