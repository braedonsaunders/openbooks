import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadConnect, connectSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Connect Shopify: shop, access method, then review before anything
 * syncs. Tenant writes go through the org-scoped /api/channels API.
 */
export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadConnect()
  return <ModuleView spec={connectSpec()} data={data} searchParams={sp} trusted />
}
