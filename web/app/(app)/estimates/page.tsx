import { ModuleView } from '../../../components/viewspec/module-view'
import { loadEstimates, estimatesSpec } from './view'

export const dynamic = 'force-dynamic'


/**
 * Estimates (quotes). The list is the universal RecordListView; this page owns
 * the header, the New button, and the OrderDrawer flyout. Quote→order/invoice
 * conversion is reported in /reports/conversion, not on the list.
 */
export default async function Estimates({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadEstimates(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={estimatesSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
