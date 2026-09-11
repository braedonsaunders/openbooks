import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadPurchasing, purchasingSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('purchasing')
  return { title: t('home.title') }
}

/**
 * Purchasing module home — the buy-to-pay workspace landing the nav group
 * header opens. The vendor commitments board (open POs beside open bills) is
 * the hero; the rail carries the 13-week spend trend, the live directory, and
 * the needs-attention queue. Tabs are ROUTES (the /ap idiom): the AP cockpit
 * stays its own page and appears here as a sibling tab when the org's nav
 * shows it.
 */
export default async function PurchasingHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const spec = await searchParams
  const data = await loadPurchasing(spec)
  return <ModuleView spec={purchasingSpec(data)} data={data} searchParams={spec} trusted />
}

