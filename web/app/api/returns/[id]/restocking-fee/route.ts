import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { assertCan } from '@/lib/authz'
import { previewReturnRestockingFee } from '@/lib/returns'

const bodySchema = z.object({
  lines: z.array(z.object({
    lineId: z.string().uuid(),
    accepted: z.string().max(40),
  })).min(1).max(500),
})

export const POST = defineRoute({
  permission: 'orders.fulfill',
  feature: 'returnAuthorizations',
  params: z.object({ id: z.string().uuid() }),
  body: bodySchema,
  handler: async ({ authz, params: { id }, body }) => {
    assertCan(authz, 'orders.fulfill')
    const preview = await previewReturnRestockingFee({
      orgId: authz.user.orgId,
      documentId: id,
      lines: body.lines,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    })
    return NextResponse.json(preview)
  },
})
