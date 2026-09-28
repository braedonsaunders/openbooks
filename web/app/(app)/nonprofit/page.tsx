import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadNonprofit, nonprofitSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('nonprofit')
  return { title: t('home.title') }
}

/**
 * Nonprofit module home — the fund-accounting workspace landing the nav
 * header opens. The pending-release queue is the hero; the directory carries
 * the funds list, the releases list, and the restriction setup beside live
 * counts. A live fund tie-out proves restricted-cash coverage per fund,
 * class, and currency, with every figure drilling to its posted journal
 * lines. Tabs are ROUTES (the purchasing idiom): funds, releases, and setup
 * are sibling pages sharing one strip.
 */
export default async function NonprofitHomePage() {
  const data = await loadNonprofit()
  return <ModuleView spec={nonprofitSpec(data)} data={data} searchParams={{}} trusted />
}
