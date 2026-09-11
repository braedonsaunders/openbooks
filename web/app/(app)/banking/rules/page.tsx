import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadBankingRules, bankingRulesSpec } from './view'

export const dynamic = 'force-dynamic'



export async function generateMetadata() {
  const t = await getTranslations('banking')
  return { title: t('rules.title') }
}

export default async function BankingRules({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadBankingRules(sp)
  return <ModuleView spec={bankingRulesSpec(data)} data={data} searchParams={sp} trusted />
}
