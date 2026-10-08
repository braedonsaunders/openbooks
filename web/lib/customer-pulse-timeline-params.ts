import { parseListParams } from './list-params'

export interface CustomerPulseTimelineItem {
  id: string
  type: 'activity' | 'estimate' | 'sales_order' | 'invoice' | 'payment' | 'stage_event'
  title: string
  description: string | null
  amount?: string
  currency?: string
  timestamp: string
  status?: string
  reference?: string
}

export interface CustomerPulseTimelinePage {
  rows: CustomerPulseTimelineItem[]
  total: number
  page: number
  perPage: number
  q: string
  dir: 'asc' | 'desc'
}

/** The embedded history owns its query keys independently of the host list. */
export function customerPulseTimelineParams(search: Record<string, string | string[] | undefined>) {
  const params = parseListParams({
    q: search.pulseHistoryQ,
    page: search.pulseHistoryPage,
    perPage: search.pulseHistoryPerPage,
    dir: search.pulseHistoryDir,
  }, { sort: 'timestamp', allowedSorts: ['timestamp'], dir: 'desc', perPage: 25 })
  return { page: params.page, perPage: params.perPage, q: (params.q ?? '').trim().slice(0, 100), dir: params.dir }
}
