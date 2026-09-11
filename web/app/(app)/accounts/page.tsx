import { ModuleView } from '../../../components/viewspec/module-view'
import { loadAccounts, accountsSpec } from './view'

export const dynamic = 'force-dynamic'


export default async function Accounts({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAccounts(sp)
  return <ModuleView spec={accountsSpec(data)} data={data} searchParams={sp} trusted />
}
