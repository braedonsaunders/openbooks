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
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={bankingAccountSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
