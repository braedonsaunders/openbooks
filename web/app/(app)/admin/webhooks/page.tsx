import { ModuleView } from '../../../components/viewspec/module-view'
import { loadWebhooks, webhooksSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Settings → Developers → Webhooks, beside API keys. Subscriber endpoints
 * receive signed domain events (orders, payments, customers, stock) with
 * retried, observable delivery. Every tenant sees only its own endpoints.
 */
export default async function WebhooksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadWebhooks(sp)
  return <ModuleView spec={webhooksSpec(data)} data={data} searchParams={sp} trusted />
}
