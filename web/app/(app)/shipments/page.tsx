import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadShipments, shipmentsSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('fulfillment')
  return { title: t('shipment.listTitle') }
}

/**
 * Shipments: the universal record list with the shipment drawer — carrier,
 * cartons, completion, void and tracking email. The loader refuses without
 * the fulfil-orders permission and while Fulfillment is off.
 */
export default async function ShipmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadShipments(sp)
  return <ModuleView spec={shipmentsSpec(data)} data={data} searchParams={sp} trusted />
}
