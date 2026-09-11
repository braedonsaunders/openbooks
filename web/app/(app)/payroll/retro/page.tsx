import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadPayrollRetro, payrollRetroSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('payroll')
  return {
    title: t.has('retro.title' as never) ? t('retro.title' as never) : 'Retroactive pay',
  }
}

/**
 * Retroactive pay — the workspace.
 *
 * A union agreement settles in March with a wage increase effective the
 * previous 1 January; ten periods have gone out at the old rate. This screen is
 * the four steps in order: find the periods whose inputs have moved since they
 * were paid, recalculate each one through the pay run's own engine, show the
 * operator old / new / already-settled / difference per employee per period,
 * and hand a draft retro pay run to the ordinary wizard.
 *
 * It lives in the PAYROLL module beside the parallel run and opening balances,
 * for the same reason: it is per-employee compensation work with its own
 * lifecycle and its own permission, not org configuration. The money it
 * produces is paid, taxed, costed and posted by the standard pay-run pipeline —
 * this page adds no second path to a cheque.
 */
export default async function PayrollRetroPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadPayrollRetro(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={payrollRetroSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
