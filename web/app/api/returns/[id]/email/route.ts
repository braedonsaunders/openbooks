import { NextResponse } from 'next/server'
import { z } from 'zod'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { guardSubsidiaryScope } from '@/lib/authz'
import { findReturnAuthorization, sendReturnAuthorizationEmail } from '@/lib/returns'

export const POST = defineRoute({
  permission: 'orders.fulfill',
  feature: 'returnAuthorizations',
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ type: z.enum(['received', 'decision']), to: z.string().email().max(320).optional() }),
  handler: async ({ authz, params: { id }, body }) => {
    const current = await findReturnAuthorization(authz.user.orgId, id, authz.allowedSubsidiaryIds)
    if (!current || guardSubsidiaryScope(authz, current.subsidiaryId)) return notFound('return_authorization', id)
    const sent = await sendReturnAuthorizationEmail({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      documentId: id,
      type: body.type,
      to: body.to,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    })
    return NextResponse.json(sent)
  },
})
