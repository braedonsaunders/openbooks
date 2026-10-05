import { ModuleView } from '../../../components/viewspec/module-view'
import { loadContractCosts, contractCostsSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function ContractCosts({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadContractCosts(sp)
  return <ModuleView spec={contractCostsSpec(data)} data={data} searchParams={sp} trusted />
}
