import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadYearEnd, yearEndSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Year-end cockpit. The sections are NOT hardcoded forms: every payroll
 * country pack declares its year-end filings (label, population, electronic
 * file, slip render, issue workflow) in the payroll filing registry, and this
 * page iterates that declaration. A pack that registers a new slip — the
 * Quebec RL-1, a UK P60 — appears here with no change to this file. Each
 * population row opens in the house Drawer as a form-faithful facsimile via
 * the shared tax-form facsimile pathway, with its PDF one click away.
 *
 * A filing is shown when its pack is installed for the org, or when its
 * population has rows (imported history from a pack that was never formally
 * installed still surfaces — hiding real wage data would be worse than an
 * extra section).
 */
export default async function PayrollYearEndPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadYearEnd(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={yearEndSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
