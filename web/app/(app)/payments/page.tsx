import { ModuleView } from '../../../components/viewspec/module-view'
import { loadPayments, paymentsSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Money out: vendor payments (with open-item application) and EFT payment
 * runs. ?view=runs switches to the run builder + run list; ?payment= and
 * ?run= open the respective flyouts.
 */
export default async function Payments({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadPayments(sp)
  return <ModuleView spec={paymentsSpec(data)} data={data} searchParams={sp} trusted />
}
