import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadCashSales, cashSalesSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('ar')
  return { title: t('list.cashTitle') }
}

/**
 * Cash sales + cash refunds — the paid-at-sale document list, one tab-click
 * from invoices in the Customers workspace. The list is the universal
 * RecordListView; this page owns the header, the New button, and the ?doc=
 * flyout with its tenders section, refund prefill, and form-layout
 * resolution.
 */
export default async function CashSales({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadCashSales(sp)
  return <ModuleView spec={cashSalesSpec(data)} data={data} searchParams={sp} trusted />
}
