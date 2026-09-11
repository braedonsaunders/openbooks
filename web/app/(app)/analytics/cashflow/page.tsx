import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadCashflow, cashflowSpec } from './view'
import { getTranslations } from 'next-intl/server'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.cashflow')
  return { title: t('title') }
}

export default async function CashflowPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadCashflow(sp)
  return <ModuleView spec={cashflowSpec(data)} data={data} searchParams={sp} trusted />
}
