import { NextResponse } from 'next/server'
import { z } from 'zod'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { guardSubsidiaryScope } from '@/lib/authz'
import { findReturnAuthorization, rejectReturnAuthorization } from '@/lib/returns'

const bodySchema = z.object({ reason: z.string().min(8).max(1000) })

export const POST = defineRoute({
  permission: 'orders.fulfill',
  feature: 'returnAuthorizations',
  params: z.object({ id: z.string().uuid() }),
  body: bodySchema,
  handler: async ({ authz, params: { id }, body }) => {
    const current = await findReturnAuthorization(authz.user.orgId, id, authz.allowedSubsidiaryIds)
    if (!current || guardSubsidiaryScope(authz, current.subsidiaryId)) return notFound('return_authorization', id)
    await rejectReturnAuthorization({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      documentId: id,
      reason: body.reason,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    })
    return NextResponse.json({ ok: true })
  },
})
