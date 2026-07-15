import { AreaChart, BarChart3, LineChart, PieChart, Table2, type LucideIcon } from 'lucide-react'
import type { VizType } from '@openbooks/analytics'

/**
 * UI metadata for the viz-type picker — message key (under the `insights`
 * namespace) + icon per chart shape. Labels are translated at the render site.
 */
export const VIZ_META: { value: VizType; labelKey: string; Icon: LucideIcon }[] = [
  { value: 'table', labelKey: 'viz.table', Icon: Table2 },
  { value: 'bar', labelKey: 'viz.bar', Icon: BarChart3 },
  { value: 'line', labelKey: 'viz.line', Icon: LineChart },
  { value: 'area', labelKey: 'viz.area', Icon: AreaChart },
  { value: 'pie', labelKey: 'viz.pie', Icon: PieChart },
]
