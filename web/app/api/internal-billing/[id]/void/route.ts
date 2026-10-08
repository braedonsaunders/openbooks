import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { voidInternalBilling } from '@openbooks/engine/internal-billing'

export const runtime = 'nodejs'

/** Controlled void: a reversal journal, subject to before-void approvals. */
export const POST = defineRoute({
  permission: 'gl.post',
  feature: 'internalBilling',
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    reason: z.string(),
    reversalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    expectedRevision: z.string().nullable().optional(),
  }).strict(),
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) => {
    const result = await voidInternalBilling({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      id: params.id,
      reason: body.reason,
      reversalDate: body.reversalDate ?? null,
      expectedRevision: body.expectedRevision ?? null,
    })
    return NextResponse.json(result)
  },
})
