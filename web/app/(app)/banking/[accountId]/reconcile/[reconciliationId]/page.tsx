import { ModuleView } from '../../../../../../components/viewspec/module-view'
import { loadReconciliation, reconcileSpec } from './view'

export const dynamic = 'force-dynamic'






export default async function ReconcilePage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string; reconciliationId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const { accountId, reconciliationId } = await params
  const data = await loadReconciliation(accountId, reconciliationId, sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={reconcileSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
