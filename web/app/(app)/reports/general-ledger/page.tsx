import { ModuleView } from '../../../../components/viewspec/module-view'
import { requireStatementAccess } from '../../../../lib/report-authz'
import { loadGeneralLedger, generalLedgerSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function GeneralLedgerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  // The statement's own read grant (ledger, receivables or payables), beyond reports.read.
  await requireStatementAccess('general-ledger', sp)
  const data = await loadGeneralLedger(sp)
  return <ModuleView spec={generalLedgerSpec(data)} data={data} searchParams={sp} trusted />
}
