import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadAccounting, accountingSpec } from './view'
// The shared attention rail — one implementation for the cockpits that use
// it. The six-row cap is a DATA decision, so it happens here and in the
// loader rather than hiding inside the component.

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('accounting')
  return { title: t('home.title') }
}

/**
 * Accounting module home — the financial-control workspace landing the nav
 * group header opens. FINANCIAL HEALTH is the hero: the score gauge with the
 * graded key ratios, served by the light financialHealth() core (the same
 * score math as analytics — the 10-tab deep dive stays there, one tab away).
 * The rail carries close progress, the live directory, and ledger hygiene.
 */
export default async function AccountingHomePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = (await searchParams) ?? {}
  const data = await loadAccounting(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={accountingSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

