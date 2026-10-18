import { NextResponse } from 'next/server'
import { z } from 'zod'
import { recordSplit } from '@openbooks/engine/equity'
import { defineRoute } from '@/lib/api/route'
import { isoDate, uuidId } from '@/lib/api/json'
import { reason, wholeShares } from '../../../_schema'

export const runtime = 'nodejs'

const params = z.object({ id: uuidId })
const body = z.object({ effectiveOn: isoDate(), ratioNumerator: wholeShares, ratioDenominator: wholeShares, reason })

/**
 * Record a stock split of a class (an approval); it restates holdings and
 * prices from its date and adjusts the conversion price of every preferred
 * class converting into it under adjusting terms.
 */
export const POST = defineRoute({
  permission: 'equity.approve',
  feature: 'equity',
  params,
  invalidParamsNotFound: 'record',
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz, params: { id }, body }) =>
    NextResponse.json(await recordSplit({ orgId: authz.user.orgId, actorId: authz.user.id, shareClassId: id, ...body }), { status: 201 }),
})
