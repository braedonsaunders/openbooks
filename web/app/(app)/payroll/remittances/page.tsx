import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadRemittances, remittancesSpec } from './view'

export const dynamic = 'force-dynamic'


/** Default period: the previous calendar month on the org's business day (the PD7A rhythm). */

export default async function PayrollRemittancesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadRemittances(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={remittancesSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
