import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadBillingHistory, billingHistorySpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Billing-platform history import (Chargebee, Recurly, Maxio, Zuora): connect
 * with an API key, review the preflight counts and Needs-attention mappings,
 * import, then reconcile MRR, open AR and deferred revenue before cut-over.
 * All data is fetched from the org-scoped /api/billing-import/* APIs, so
 * every tenant sees only its own runs.
 */
export default async function BillingHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadBillingHistory()
  return <ModuleView spec={billingHistorySpec()} data={data} searchParams={sp} trusted />
}
