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
