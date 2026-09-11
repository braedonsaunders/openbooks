import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadPayRuns, payRunsSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('payroll')
  return { title: t('list.title') }
}

/**
 * Pay runs — the universal RecordListView over documents kind 'pay_run'
 * (search, merged-lifecycle stage chips, schedule + date-range filters, saved
 * views, sortable typed columns, pagination). Rows open the pay-run wizard —
 * a full page, not a drawer — via the list source's link override.
 */
export default async function PayRunsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadPayRuns(sp)
  return <ModuleView spec={payRunsSpec(data)} data={data} searchParams={sp} trusted />
}
