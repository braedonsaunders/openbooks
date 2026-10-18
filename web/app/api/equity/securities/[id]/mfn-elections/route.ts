import { NextResponse } from 'next/server'
import { z } from 'zod'
import { electMfnTerms } from '@openbooks/engine/equity'
import { defineRoute } from '@/lib/api/route'
import { isoDate, uuidId } from '@/lib/api/json'
import { idempotencyKey, reason } from '../../../_schema'

export const runtime = 'nodejs'

const params = z.object({ id: uuidId })
const body = z.object({ sourceSecurityId: uuidId, effectiveOn: isoDate(), reason, idempotencyKey })

/**
 * Record an MFN SAFE holder's election to adopt a later instrument's better
 * cap, discount and SAFE type from a date (an approval). Conversions from
 * that date use the adopted terms.
 */
export const POST = defineRoute({
  permission: 'equity.approve',
  feature: 'equity',
  params,
  invalidParamsNotFound: 'record',
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz, params: { id }, body }) => {
    const result = await electMfnTerms({ orgId: authz.user.orgId, actorId: authz.user.id, securityId: id, ...body })
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 })
  },
})
