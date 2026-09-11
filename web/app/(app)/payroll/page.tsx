import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadPayroll, payrollSpec } from './view'
import {
} from './sections'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('payroll')
  return { title: t('title') }
}

/**
 * Payroll module home — the landing cockpit. The per-schedule current-period
 * cards are the hero (period, pay date, and the one smart action: Start /
 * Resume / Review), flanked by YTD vitals, the previous completed period, the
 * exception queues (missing profiles / wages — surfaced BEFORE a run trips on
 * them), and the live directory. Employees live on the NATIVE entity list
 * (/entities/employees) — payroll deliberately has no second roster; profiles
 * are a tab on the employee drawer.
 */
export default async function PayrollHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadPayroll(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={payrollSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

/* ------------------------------------------------------------------------- */

/** Moved to ./sections so the page and the widget registry share one short-date formatter. */
