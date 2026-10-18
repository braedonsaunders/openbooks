import { NextResponse } from 'next/server'
import { z } from 'zod'
import { recordSecurityEvent } from '@openbooks/engine/equity'
import { defineRoute } from '@/lib/api/route'
import { isoDate, uuidId } from '@/lib/api/json'
import { decimalText, idempotencyKey, reason, wholeShares } from '../../../_schema'

export const runtime = 'nodejs'

const params = z.object({ id: uuidId })

const approvalBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('repurchase'),
    effectiveOn: isoDate(),
    quantity: wholeShares,
    amount: decimalText.nullable().optional(),
    fairMarketValuePerShare: decimalText.nullable().optional(),
    considerationAccountId: uuidId.nullable().optional(),
    reason,
    idempotencyKey,
  }),
  z.object({ kind: z.literal('void'), effectiveOn: isoDate(), reason, idempotencyKey }),
  z.object({ kind: z.literal('reverse'), effectiveOn: isoDate(), reversesEventId: uuidId, reason, idempotencyKey }),
  z.object({ kind: z.literal('repay'), effectiveOn: isoDate(), amount: decimalText, considerationAccountId: uuidId, reason: reason.nullable().optional(), idempotencyKey }),
  z.object({ kind: z.literal('cancel'), effectiveOn: isoDate(), reason, idempotencyKey }),
])

/**
 * Governed corrections, buybacks and settlements (equity.approve): a
 * repurchase into treasury (unvested early-exercised shares at the grant's
 * repurchase price), the repayment or cancellation of a SAFE or note, a void
 * that reverses the security's entry and undoes the event that produced it,
 * or the reversal of one forfeiture, expiry, cancellation, repurchase,
 * repayment or 83(b) election recorded in error.
 */
export const POST = defineRoute({
  permission: 'equity.approve',
  feature: 'equity',
  params,
  invalidParamsNotFound: 'record',
  body: approvalBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, params: { id }, body }) => {
    const result = await recordSecurityEvent({ orgId: authz.user.orgId, actorId: authz.user.id, securityId: id, ...body })
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 })
  },
})
