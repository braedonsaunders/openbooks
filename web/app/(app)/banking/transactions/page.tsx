import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadBankingTransactions, bankingTransactionsSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('banking')
  return { title: t('transactionsPage.title') }
}


// Kinds that keep a bespoke drawer form (no customizable form layout): transfers
// (to/from legs) and deposits (destination bank + source lines).

export default async function BankingTransactions({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadBankingTransactions(sp)
  return <ModuleView spec={bankingTransactionsSpec(data)} data={data} searchParams={sp} trusted />
}
