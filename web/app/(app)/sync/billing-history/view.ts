import 'server-only'

import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '@/lib/authz'
import { requireFeatureEnabled } from '@/lib/feature-gates'

/**
 * The billing-history console owns ListPageLayout and PageHeader because run
 * visibility arrives with the API payload. The spec delegates to that shared
 * shell without nesting a second scroll container. Hidden while the
 * billingHistoryImport gate is off; data is kept.
 */

export type BillingHistoryData = Record<string, never>

export async function loadBillingHistory(): Promise<BillingHistoryData> {
  const authz = await requirePermission('sync.run')
  await requireFeatureEnabled(authz.user.orgId, 'billingHistoryImport')
  return {}
}

export function billingHistorySpec(): PageSpec {
  return page({
    route: '/sync/billing-history',
    layout: 'bare',
    header: [],
    body: [widgetBlock('billing-history-console')],
  })
}
