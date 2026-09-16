import { z } from 'zod'
import type { DashboardLayoutData } from '@openbooks/schema'
import { isUuid } from '../../../lib/list-params'
import { WIDGETS } from './_widget-registry'
import { isAppWidgetId } from '../../../lib/apps/surfaces'

const WidgetSchema = z.object({
  id: z.string().min(1),
  x: z.number().int().min(0).max(12),
  y: z.number().int().min(0).max(200),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(20),
})

export const DashboardLayoutInputSchema = z.object({
  widgets: z.array(WidgetSchema).max(64),
})

type DashboardLayoutWidgetInput = z.infer<typeof WidgetSchema>

/**
 * A stored layout may predate a widget's current minimum size (the grid
 * only enforces minimums while the user resizes). Grow such widgets to the
 * registry minimum on read so a card is never rendered smaller than the
 * size its content was designed for; the grid keeps the width inside the
 * 12-column row.
 */
export function clampToWidgetMinimums<T extends { id: string; x: number; w: number; h: number }>(widgets: T[]): T[] {
  return widgets.map((widget) => {
    const meta = WIDGETS[widget.id]
    if (!meta) return widget
    const w = Math.max(widget.w, meta.minSize.w)
    const h = Math.max(widget.h, meta.minSize.h)
    if (w === widget.w && h === widget.h) return widget
    return { ...widget, w, x: Math.min(widget.x, Math.max(0, 12 - w)), h }
  })
}

export function filterPersistableDashboardWidgets(
  widgets: DashboardLayoutWidgetInput[],
  opts: {
    allowedWidgetIds?: ReadonlySet<string>
    allowedAppWidgetIds?: ReadonlySet<string>
    allowAnyInsightCardUuid?: boolean
  } = {},
): DashboardLayoutData['widgets'] {
  return widgets.filter((w) => {
    if (w.id in WIDGETS) return !opts.allowedWidgetIds || opts.allowedWidgetIds.has(w.id)
    if (isAppWidgetId(w.id)) return opts.allowedAppWidgetIds?.has(w.id) === true
    if (!isUuid(w.id)) return false
    return opts.allowAnyInsightCardUuid === true
  })
}
