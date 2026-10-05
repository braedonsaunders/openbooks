import { NextResponse } from 'next/server'
import { z } from 'zod'
import { runContractCostAmortization } from '@openbooks/engine/revenue'
import { defineRoute } from '@/lib/api/route'
import { parseJsonBody, uuidId } from '@/lib/api/json'
import { contractCostErrorResponse } from '@/lib/contract-costs'

export const runtime = 'nodejs'

const runBody = z.object({
  periodId: z.string().refine((v) => uuidId.safeParse(v).success, 'invalid period'),
})

/**
 * Run amortization for one period: posts every due, unposted asset line
 * through the kernel, idempotently per asset and period. Closed periods
 * skip with a queue note; unlinked commissions queue for linking.
 */
export const POST = defineRoute({
  permission: 'contract_costs.manage',
  feature: 'contractCosts',
  handler: async ({ request: req, authz: gate }) => {
    const user = gate.user
    const parsed = await parseJsonBody(req, runBody, { status: 422 })
    if (!parsed.ok) return parsed.response
    try {
      const result = await runContractCostAmortization({
        orgId: user.orgId,
        actorId: user.id,
        periodId: parsed.data.periodId,
      })
      return NextResponse.json(result)
    } catch (e: unknown) {
      return contractCostErrorResponse(e, 'Unable to run contract cost amortization.')
    }
  },
})
