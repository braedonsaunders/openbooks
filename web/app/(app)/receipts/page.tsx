import { ModuleView } from '../../../components/viewspec/module-view'
import { loadReceipts, receiptsSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Money in: customer receipts applied to open AR items — the mirror of
 * /payments, sharing its flyout and list section with side='ar'.
 */
export default async function Receipts({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadReceipts(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={receiptsSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
