import { ModuleView } from '../../../../components/viewspec/module-view'
import { requireStatementAccess } from '../../../../lib/report-authz'
import { loadAging, agingSpec } from './view'

export const dynamic = 'force-dynamic'



export default async function Aging({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  // The statement's own read grant (ledger, receivables or payables), beyond reports.read.
  await requireStatementAccess('aging', sp)
  const data = await loadAging(sp)
  return <ModuleView spec={agingSpec(data)} data={data} searchParams={sp} trusted />
}
