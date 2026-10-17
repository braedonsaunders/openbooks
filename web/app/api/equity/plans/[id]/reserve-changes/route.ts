import { NextResponse } from 'next/server'
import { z } from 'zod'
import { changePlanReserve } from '@openbooks/engine/equity'
import { defineRoute } from '@/lib/api/route'
import { isoDate, uuidId } from '@/lib/api/json'
import { reason, signedShares } from '../../../_schema'

export const runtime = 'nodejs'

const params = z.object({ id: uuidId })
const body = z.object({ effectiveOn: isoDate(), shareDelta: signedShares, reason })

/** Increase or reduce a plan's reserve from a date (an approval). */
export const POST = defineRoute({
  permission: 'equity.approve',
  feature: 'equity',
  params,
  invalidParamsNotFound: 'record',
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz, params: { id }, body }) =>
    NextResponse.json(await changePlanReserve({ orgId: authz.user.orgId, actorId: authz.user.id, planId: id, ...body }), { status: 201 }),
})
