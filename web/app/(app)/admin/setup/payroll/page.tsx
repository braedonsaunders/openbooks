import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadPayrollSetup, payrollSetupSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Payroll setup — a two-level workspace. The TOP row is four GROUPS on the
 * house border-b tab strip (the Close-setup / Tax-setup subtab idiom); the
 * second level inside a group is the ModuleHomeTabs pill strip (the module
 * homes' route-tab switcher), so a dozen-plus surfaces never crowd one row.
 * Country packs are the front door; accounts & posting own
 * orgs.settings.payroll; schedules, components, and union agreements are the
 * re-homed registry entities that left the setup rail to live here.
 *
 * Deep links: every historical `?tab=` value keeps working — tab keys are
 * unchanged, the group is inferred FROM the tab, and the readiness Resolve
 * links that name a pack (`?tab=ca`, `?tab=us`) alias to the accounts tab
 * where the statutory slots are mapped. All of that now lives in ./view.ts.
 */
export default async function PayrollSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadPayrollSetup(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={payrollSetupSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
