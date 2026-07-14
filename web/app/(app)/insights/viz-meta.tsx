import { AreaChart, BarChart3, LineChart, PieChart, Table2, type LucideIcon } from 'lucide-react'
import type { VizType } from '@openbooks/analytics'

/** UI metadata for the viz-type picker — label + icon per chart shape. */
export const VIZ_META: { value: VizType; label: string; Icon: LucideIcon }[] = [
  { value: 'table', label: 'Table', Icon: Table2 },
  { value: 'bar', label: 'Bar', Icon: BarChart3 },
  { value: 'line', label: 'Line', Icon: LineChart },
  { value: 'area', label: 'Area', Icon: AreaChart },
  { value: 'pie', label: 'Pie', Icon: PieChart },
]
