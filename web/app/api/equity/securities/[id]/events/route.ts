import { NextResponse } from 'next/server'
import { z } from 'zod'
import { recordSecurityEvent } from '@openbooks/engine/equity'
import { defineRoute } from '@/lib/api/route'
import { isoDate, uuidId } from '@/lib/api/json'
import { idempotencyKey, wholeShares } from '../../../_schema'

export const runtime = 'nodejs'

const params = z.object({ id: uuidId })

const common = { effectiveOn: isoDate(), idempotencyKey, reason: z.string().trim().max(2000).nullable().optional() }

const eventBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exercise'), quantity: wholeShares, considerationAccountId: uuidId.nullable().optional(), ...common }),
  z.object({ kind: z.literal('settle'), quantity: wholeShares, ...common }),
  z.object({ kind: z.literal('forfeit'), quantity: wholeShares, ...common }),
  z.object({ kind: z.literal('expire'), quantity: wholeShares, ...common }),
  z.object({ kind: z.literal('cancel'), quantity: wholeShares, ...common }),
  z.object({ kind: z.literal('transfer'), quantity: wholeShares, transfereePartyId: uuidId, ...common }),
  z.object({ kind: z.literal('convert'), quantity: wholeShares.nullable().optional(), roundId: uuidId.nullable().optional(), targetShareClassId: uuidId.nullable().optional(), ...common }),
])

/**
 * Record award and share activity: exercise, settlement, forfeiture, expiry,
 * cancellation, transfer or conversion. Exercises, settlements and
 * conversions write the resulting certificate and post their entry.
 */
export const POST = defineRoute({
  permission: 'equity.manage',
  feature: 'equity',
  params,
  invalidParamsNotFound: 'record',
  body: eventBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, params: { id }, body }) => {
    const result = await recordSecurityEvent({ orgId: authz.user.orgId, actorId: authz.user.id, securityId: id, ...body })
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 })
  },
})
