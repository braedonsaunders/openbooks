import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadSeparations, separationsSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Separations cockpit — the home of SEPARATION filings (cadence
 * "separation" in the payroll filing registry): documents due per
 * interruption of earnings, within days of the employee event (the CA
 * pack's Record of Employment; a UK pack's P45 would attach the same way).
 * These are event documents, not year-end returns, which is why they are
 * not on /payroll/year-end.
 *
 * The page iterates the same registry declaration as year-end — every
 * employee with an interruption of earnings (the pack's declared
 * population), each row opening the shared slip drawer with the
 * form-faithful facsimile and the pack's reason-for-issue flow.
 */
export default async function PayrollSeparationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadSeparations(sp)
  return <ModuleView spec={separationsSpec(data)} data={data} searchParams={sp} trusted />
}
