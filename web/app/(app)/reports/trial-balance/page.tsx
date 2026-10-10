import { ModuleView } from '../../../../components/viewspec/module-view'
import { requireStatementAccess } from '../../../../lib/report-authz'
import { loadTrialBalance, trialBalanceSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function TrialBalance({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp0 = await searchParams
  // The statement's own read grant (ledger, receivables or payables), beyond reports.read.
  await requireStatementAccess('trial-balance', sp0)
  const data = await loadTrialBalance(sp0)
  return <ModuleView spec={trialBalanceSpec(data)} data={data} searchParams={sp0} trusted />
}
