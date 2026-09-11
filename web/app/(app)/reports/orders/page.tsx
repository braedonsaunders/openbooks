import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadOrders, ordersSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Order pipeline report — open backlog (count + value) and conversion for
 * quotes, sales orders and purchase orders. Conversion moved here from the list
 * pages: it's an analytical roll-up, not a per-row list column. Conversion is
 * derived from document_links (from order → downstream invoice/bill).
 */
export default async function OrdersReport({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | undefined>>
}) {
  const sp = (await searchParams) ?? {}
  const data = await loadOrders()
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={ordersSpec()} data={data} searchParams={sp} trusted />
    </>
  )
}
