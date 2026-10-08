import 'server-only'
import { currentAnalyticsRead } from './read-context'
import { cmp } from '@openbooks/engine/money'
import type { VendorData } from './vendor-data'
import type { CustomerData } from './customer-data'

function isOverview(slug: string): boolean {
  const read = currentAnalyticsRead()
  return read?.slug === slug && read.projection === 'tab' && read.tab === 'overview'
}

/** The overview charts display ten vendors; portfolio totals keep the full scope. */
export function projectVendorDashboard(data: VendorData): VendorData {
  if (!isOverview('vendor-performance')) return data
  return { ...data, rows: data.rows.slice(0, 10) }
}

/** Customer health ordering is retained in detail reads; the overview ranks revenue exactly. */
export function projectCustomerDashboard(data: CustomerData): CustomerData {
  if (!isOverview('customer-intelligence')) return data
  return { ...data, rows: [...data.rows].sort((a, b) => cmp(b.revenue, a.revenue)).slice(0, 10) }
}
