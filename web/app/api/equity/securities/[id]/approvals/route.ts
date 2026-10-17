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
    amount: decimalText,
    considerationAccountId: uuidId.nullable().optional(),
    reason,
    idempotencyKey,
  }),
  z.object({ kind: z.literal('void'), effectiveOn: isoDate(), reason, idempotencyKey }),
])

/**
 * Governed corrections and buybacks (equity.approve): a repurchase into
 * treasury, or a void that reverses the security's entry on the void date
 * and undoes the event that produced it.
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
