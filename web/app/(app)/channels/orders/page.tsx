import { ModuleView } from '../../../components/viewspec/module-view'
import { loadChannelOrders, channelOrdersSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Channels → Orders — every storefront order with its posting status badge
 * and document link. The list reads the org-scoped channel order subledger,
 * so every tenant sees only its own orders.
 */
export default async function ChannelOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadChannelOrders(sp)
  return <ModuleView spec={channelOrdersSpec(data)} data={data} searchParams={sp} trusted />
}
