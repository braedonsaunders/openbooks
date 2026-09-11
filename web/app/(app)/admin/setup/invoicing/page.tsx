import { ModuleView } from '../../../../../components/viewspec/module-view'
import { invoicingSetupSpec, loadInvoicingSetup } from './view'

export const dynamic = 'force-dynamic'

/**
 * Authoritative company policy for customer-invoice workflows. Project billing
 * is summarized here but remains governed by the Projects parent gate and the
 * project's effective type profile.
 */
export default async function InvoicingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadInvoicingSetup()
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={invoicingSetupSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
