import { NextResponse } from 'next/server'
import { z } from 'zod'
import { linkContractCostAsset } from '@openbooks/engine/revenue'
import { defineRoute } from '../../../../lib/api/route'
import { parseJsonBody, uuidId } from '../../../../lib/api/json'
import { contractCostErrorResponse } from '../../../../lib/contract-costs'

export const runtime = 'nodejs'

const linkBody = z.object({
  assetId: z.string().refine((v) => uuidId.safeParse(v).success, 'invalid asset'),
  revenueContractId: z.string().refine((v) => uuidId.safeParse(v).success, 'invalid contract'),
})

/**
 * Link an imported commission to its revenue contract: recomputes the
 * amortization window from the live policy and posts the capitalization
 * journal when the asset carries none yet.
 */
export const POST = defineRoute({
  permission: 'contract_costs.manage',
  feature: 'contractCosts',
  handler: async ({ request: req, authz: gate }) => {
    const user = gate.user
    const parsed = await parseJsonBody(req, linkBody, { status: 422 })
    if (!parsed.ok) return parsed.response
    try {
      const result = await linkContractCostAsset({
        orgId: user.orgId,
        actorId: user.id,
        assetId: parsed.data.assetId,
        revenueContractId: parsed.data.revenueContractId,
      })
      return NextResponse.json(result)
    } catch (e: unknown) {
      return contractCostErrorResponse(e, 'Unable to link the commission to its contract.')
    }
  },
})
