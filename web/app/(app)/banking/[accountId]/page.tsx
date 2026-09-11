import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadBankingAccount, bankingAccountSpec } from './view'

export const dynamic = 'force-dynamic'






export default async function BankingAccount({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const { accountId } = await params
  const data = await loadBankingAccount(accountId, sp)
  return <ModuleView spec={bankingAccountSpec(data)} data={data} searchParams={sp} trusted />
}
