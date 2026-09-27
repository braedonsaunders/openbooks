import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadReplenishment, replenishmentSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('warehouse.replenishment')
  return { title: t('title') }
}

/**
 * Replenishment report: for each stocked item of one legal entity, projected
 * supply against its reorder point and the quantity that restores its
 * preferred level, with the evidence behind every proposal. The loader
 * refuses with the Features-page remedy while Warehousing is off.
 */
export default async function ReplenishmentReport({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadReplenishment(sp)
  return <ModuleView spec={replenishmentSpec(data)} data={data} searchParams={sp} trusted />
}
