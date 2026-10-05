import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  AutopayError,
  saveAutopayPolicy,
} from '@openbooks/engine/payments/autopay'
import { uuidId } from '@/lib/api/json'
import { defineRoute } from '@/lib/api/route'
import { guardUnrestrictedScope } from '@/lib/authz'

export const runtime = 'nodejs'

const policyBody = z.object({
  policyId: uuidId,
  retryOffsetsDays: z.array(z.number()),
  insufficientFundsOffsetsDays: z.array(z.number()).optional(),
  expiryNoticeDays: z.number().int().optional(),
  finalAction: z.enum(['none', 'suspend', 'cancel']),
})

/**
 * Save the autopay retry schedule and final action on a collection policy.
 * The engine validates exactly what the scan will execute.
 */
export const POST = defineRoute({
  permission: 'autopay.manage',
  feature: 'autopay',
  body: policyBody,
  handler: async ({ authz, body }) => {
    // A collection policy governs autopay for customers of every subsidiary.
    const scopeDenied = guardUnrestrictedScope(authz)
    if (scopeDenied) return scopeDenied
    try {
      const policy = await saveAutopayPolicy(authz.user.orgId, {
        policyId: body.policyId,
        retryOffsetsDays: body.retryOffsetsDays,
        insufficientFundsOffsetsDays: body.insufficientFundsOffsetsDays,
        expiryNoticeDays: body.expiryNoticeDays,
        finalAction: body.finalAction,
        actorId: authz.user.id,
      })
      return NextResponse.json({ policy })
    } catch (e) {
      if (e instanceof AutopayError) return apiErrorResponse(e, { safeStatus: 422 })
      throw e
    }
  },
})
