import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadPicks, picksSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('fulfillment')
  return { title: t('pick.listTitle') }
}

/**
 * Pick lists: the universal record list with the pick-list drawer and the
 * create form reached from an issued sales order. The loader refuses without
 * the fulfil-orders permission and while Fulfillment is off.
 */
export default async function PicksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadPicks(sp)
  return <ModuleView spec={picksSpec(data)} data={data} searchParams={sp} trusted />
}
