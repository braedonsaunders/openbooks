import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { postInternalBilling } from '@openbooks/engine/internal-billing'

export const runtime = 'nodejs'

/** Submit and post through the native lifecycle; an approval flow may hold it. */
export const POST = defineRoute({
  permission: 'gl.post',
  feature: 'internalBilling',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ authz, params }) => {
    const outcome = await postInternalBilling({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      id: params.id,
    })
    return NextResponse.json(outcome, { status: outcome.status === 'pending_approval' ? 202 : 200 })
  },
})
