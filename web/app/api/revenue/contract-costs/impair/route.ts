import { NextResponse } from 'next/server'
import { z } from 'zod'
import { recognizeContractCostImpairment } from '@openbooks/engine/revenue'
import { defineRoute } from '@/lib/api/route'
import { isoDate, parseJsonBody, uuidId } from '@/lib/api/json'
import { contractCostErrorResponse, parseCostAmountMinor } from '@/lib/contract-costs'

export const runtime = 'nodejs'

const impairBody = z.object({
  assetId: z.string().refine((v) => uuidId.safeParse(v).success, 'invalid asset'),
  remainingConsideration: z.string().min(1),
  costsNotYetRecognized: z.string().optional(),
  currency: z.string().min(3).max(3),
  reason: z.string().min(8).max(2000),
  assessedOn: isoDate(),
})

/**
 * Recognize impairment: writes the asset down to its recoverable amount
 * when the carrying amount exceeds it. Segregated duty — the route
 * requires the approve permission the manage routes never grant.
 */
export const POST = defineRoute({
  permission: 'contract_costs.approve',
  feature: 'contractCosts',
  handler: async ({ request: req, authz: gate }) => {
    const user = gate.user
    const parsed = await parseJsonBody(req, impairBody, { status: 422 })
    if (!parsed.ok) return parsed.response
    const body = parsed.data
    try {
      const result = await recognizeContractCostImpairment({
        orgId: user.orgId,
        actorId: user.id,
        assetId: body.assetId,
        remainingConsiderationMinor: await parseCostAmountMinor(user.orgId, body.remainingConsideration, body.currency),
        costsNotYetRecognizedMinor: body.costsNotYetRecognized
          ? await parseCostAmountMinor(user.orgId, body.costsNotYetRecognized, body.currency)
          : 0n,
        reason: body.reason,
        assessedOn: body.assessedOn,
      })
      return NextResponse.json(result, { status: 201 })
    } catch (e: unknown) {
      return contractCostErrorResponse(e, 'Unable to recognize the impairment.')
    }
  },
})
