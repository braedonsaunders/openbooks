import { NextResponse } from 'next/server'
import { z } from 'zod'
import { amendShareClass } from '@openbooks/engine/equity'
import { defineRoute } from '@/lib/api/route'
import { isoDate, uuidId } from '@/lib/api/json'
import { optionalDecimal, reason, wholeShares } from '../../../_schema'

export const runtime = 'nodejs'

const params = z.object({ id: uuidId })
const body = z.object({
  kind: z.enum(['authorized_shares', 'conversion_price', 'conversion_class']),
  effectiveOn: isoDate(),
  authorizedShares: wholeShares.nullable().optional(),
  conversionPrice: optionalDecimal,
  conversionShareClassId: uuidId.nullable().optional(),
  reason,
})

/** Amend a class's authorized shares, conversion price or conversion class from a date (an approval). */
export const POST = defineRoute({
  permission: 'equity.approve',
  feature: 'equity',
  params,
  invalidParamsNotFound: 'record',
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz, params: { id }, body }) =>
    NextResponse.json(await amendShareClass({ orgId: authz.user.orgId, actorId: authz.user.id, shareClassId: id, ...body }), { status: 201 }),
})
