import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadPayouts, payoutsSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Banking → Payouts: every provider payout with its order lines, its bank
 * deposit tie-out and its in-transit accruals. Tiles count what still needs
 * a person; each row opens the payout drawer with line matching. All data
 * is fetched from the org-scoped /api/psp/settlements API, so every tenant
 * sees only its own payouts.
 */
export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadPayouts(sp)
  return <ModuleView spec={payoutsSpec()} data={data} searchParams={sp} trusted />
}
