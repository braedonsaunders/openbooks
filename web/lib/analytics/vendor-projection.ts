import 'server-only'
import { currentAnalyticsRead } from './read-context'
import type { VendorData } from './vendor-data'

/** The overview charts display ten vendors; portfolio totals keep the full scope. */
export function projectVendorDashboard(data: VendorData): VendorData {
  const read = currentAnalyticsRead()
  if (read?.slug !== 'vendor-performance' || read.projection !== 'tab' || read.tab !== 'overview') return data
  return { ...data, rows: data.rows.slice(0, 10) }
}
