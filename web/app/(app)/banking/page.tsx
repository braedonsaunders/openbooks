import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadBanking, bankingSpec } from './view'
export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('banking')
  return { title: t('home.title') }
}

/** Statements older than this are flagged as a stale feed on the roster. */

/**
 * Banking module home — the workspace landing cockpit the nav group header
 * opens. The account roster is the hero (the page's headline object); the
 * rail carries the 13-week cash trend, the live directory (the rest of the
 * workspace's pages annotated with what needs doing there), and a
 * needs-attention queue. Tabs are ROUTES (the /ap idiom): the Cash Position
 * cockpit stays its own page and appears here as a sibling tab when the org's
 * nav shows it.
 */
export default async function BankingHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadBanking(sp)
  return <ModuleView spec={bankingSpec(data)} data={data} searchParams={sp} trusted />
}

/* ------------------------------------------------------------------------- */

/**
 * needsAttention, daysSince and weekLabel now live in ./view.ts — the loader
 * owns them and the widget registry renders it, so there is one implementation* and no second copy to drift (the purchasing precedent). STALE_STATEMENT_DAYS
 * stays here: the loader defines its own copy for the badge computation.
 */
