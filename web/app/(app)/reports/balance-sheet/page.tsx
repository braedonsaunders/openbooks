import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadBalanceSheet, balanceSheetSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function BalanceSheet({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp0 = await searchParams
  const data = await loadBalanceSheet(sp0)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={balanceSheetSpec(data)} data={data} searchParams={sp0} trusted />
    </>
  )
}
