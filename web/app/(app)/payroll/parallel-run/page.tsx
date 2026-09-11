import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadParallelRun, parallelRunSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('payroll')
  return {
    title: t.has('parallelRun.title' as never) ? t('parallelRun.title' as never) : 'Parallel run',
  }
}

/**
 * Parallel run — the adoption control.
 *
 * Nobody moves payroll without running both systems side by side for a period
 * or two and proving every number, and until now that was a spreadsheet. This
 * screen is the operator's side of it: pick the register imported from the
 * outgoing provider, pick the run to check it against, compare, and drill into
 * an employee's differences.
 *
 * It lives in the PAYROLL module rather than on the /admin/setup rail for the
 * same reasons opening balances do — it is per-employee compensation data with
 * its own lifecycle, gated on payroll's own permissions. Files come in through
 * the shared import wizard (/data/import, resource "Prior payroll register");
 * the tabular output is a REAL report (Reports → Parallel run reconciliation)
 * with the native filter bar, saved views, PDF/Excel/CSV and scheduling. This
 * page is the workspace that runs the comparison and reads its exceptions.
 */
export default async function PayrollParallelRunPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadParallelRun(sp)
  return <ModuleView spec={parallelRunSpec(data)} data={data} searchParams={sp} trusted />
}
