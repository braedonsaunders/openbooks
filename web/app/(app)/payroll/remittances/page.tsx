import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadRemittances, remittancesSpec } from './view'

export const dynamic = 'force-dynamic'


/** Default period: the previous calendar month on the org's business day (the PD7A rhythm). */

export default async function PayrollRemittancesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadRemittances(sp)
  return <ModuleView spec={remittancesSpec(data)} data={data} searchParams={sp} trusted />
}
