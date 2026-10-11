import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { createBookAccountMap, listBookAccountMaps } from '@openbooks/engine/multibook'

export const runtime = 'nodejs'

const createBody = z.object({
  bookId: z.string().uuid(),
  subsidiaryId: z.string().uuid().nullable().optional(),
  sourceAccountId: z.string().uuid(),
  targetAccountId: z.string().uuid(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable().optional(),
  reason: z.string(),
}).strict()

/** Every book account mapping version. */
export const GET = defineRoute({
  permission: 'gl.read',
  feature: 'multiBookAccounting',
  handler: async ({ authz }) => NextResponse.json({ maps: await listBookAccountMaps(authz.user.orgId) }),
})

/**
 * Map a chart account to the account a secondary book carries it in. The
 * mapping keeps the statement class, honours currency restrictions and must
 * be available to every subsidiary it covers.
 */
export const POST = defineRoute({
  permission: 'admin.setup.manage',
  feature: 'multiBookAccounting',
  scope: 'unrestricted',
  body: createBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    const { reason, ...input } = body
    const created = await createBookAccountMap({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      input,
      reason,
    })
    return NextResponse.json(created, { status: 201 })
  },
})
