import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { availabilitySpec, loadAvailability } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('warehouse.availability')
  return { title: t('title') }
}

/**
 * Availability report: on hand, committed, available and unallocated demand
 * per stocked item for one legal entity, and the open order lines stock on
 * hand could ship now. The loader refuses with the Features-page remedy while
 * Warehousing is off.
 */
export default async function AvailabilityReport({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAvailability(sp)
  return <ModuleView spec={availabilitySpec(data)} data={data} searchParams={sp} trusted />
}
