import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadCashFlowIndirect, cashFlowIndirectSpec } from './view'

export const dynamic = 'force-dynamic'



export default async function CashFlowIndirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadCashFlowIndirect(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={cashFlowIndirectSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}






