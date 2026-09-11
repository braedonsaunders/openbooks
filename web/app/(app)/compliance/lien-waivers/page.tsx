import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadLienWaiversPage, lienWaiversSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('compliance')
  return { title: t('lienWaivers.title') }
}


/**
 * Lien waivers received from subcontractors and issued to owners.
 *
 * The list leads with THROUGH-DATE and AMOUNT because those two fields are what
 * the payment control reads — everything else on the row is context. A waiver
 * that reads "signed" here is a waiver that will release a blocked bill.
 */
export default async function LienWaiversPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadLienWaiversPage(sp)
  return <ModuleView spec={lienWaiversSpec(data)} data={data} searchParams={sp} trusted />
}
