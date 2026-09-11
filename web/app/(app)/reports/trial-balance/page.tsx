import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadTrialBalance, trialBalanceSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function TrialBalance({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp0 = await searchParams
  const data = await loadTrialBalance(sp0)
  return <ModuleView spec={trialBalanceSpec(data)} data={data} searchParams={sp0} trusted />
}
