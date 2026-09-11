import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadApBills, apBillsSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('ap')
  return { title: t('list.title') }
}

/**
 * Vendor bills + credits — the AP document list, a first-class route beside
 * the /ap cockpit (both are one tab-click apart). The list (search, filters,
 * saved views, sortable typed table, drill-through, pagination) is the
 * universal RecordListView; this page owns the header, the New button, and
 * the ?doc= document flyout with its form-layout resolution.
 */
export default async function ApBills({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadApBills(sp)
  return <ModuleView spec={apBillsSpec(data)} data={data} searchParams={sp} trusted />
}
