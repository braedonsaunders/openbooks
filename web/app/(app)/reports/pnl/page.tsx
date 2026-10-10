import { ModuleView } from '../../../../components/viewspec/module-view'
import { requireStatementAccess } from '../../../../lib/report-authz'
import { loadPnl, pnlSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function PnL({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  // The statement's own read grant (ledger, receivables or payables), beyond reports.read.
  await requireStatementAccess('pnl', sp)
  const data = await loadPnl(sp)
  return <ModuleView spec={pnlSpec(data)} data={data} searchParams={sp} trusted />
}
