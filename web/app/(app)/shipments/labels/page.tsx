import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadBulkBuy, bulkBuySpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('fulfillment')
  return { title: t('shipping.bulk.metaTitle') }
}

/**
 * Buy labels: price draft shipments under one buying rule and buy the
 * ready rows in one step, with one merged PDF for the printer.
 */
export default async function BulkBuyPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = (await searchParams) ?? {}
  const data = await loadBulkBuy(sp)
  return <ModuleView spec={bulkBuySpec(data)} data={data} searchParams={sp} trusted />
}
