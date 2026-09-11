import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadBankingCash, bankingCashSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('banking.cash')
  return { title: t('title') }
}

/**
 * Cash control center — whole-company liquidity off the shared cash engine.
 * Operational counterpart to analytics/cashflow: this page is where you act on
 * cash (runway, lowest point, the weekly timeline with per-week drill and the
 * forecast config); the analytics dashboard is where you explain it.
 */
export default async function BankingCashPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadBankingCash(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={bankingCashSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
