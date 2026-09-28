import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { uuidId } from '../../../../lib/api/json'
import { guardPermission, guardSubsidiaryScope } from '../../../../lib/authz'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { encumbranceSubsidiaryId, linkEncumbranceDocumentLine } from '@openbooks/engine/src/nonprofit/encumbrances.ts'

export const runtime = 'nodejs'

/**
 * Encumbrance liquidation: binding a posting document line as an actual
 * against the commitment. Both encumbrances.manage and gl.post are proven in
 * authorize() — before the feature check and the body parse — and the stored
 * subsidiary gates the link, so a restricted caller can only liquidate inside
 * their own scope.
 */
const liquidationBody = z.strictObject({
  action: z.literal('link'),
  encumbranceId: uuidId,
  documentLineId: uuidId,
})

export const POST = defineRoute({
  authorize: async () => {
    // Same NextResponse normalization as the grant postings route: the
    // factory answers identity, so the denial is re-minted, never forwarded.
    const manage = await guardPermission('encumbrances.manage')
    if (manage instanceof Response) return NextResponse.json(await manage.json(), { status: manage.status })
    const post = await guardPermission('gl.post')
    if (post instanceof Response) return NextResponse.json(await post.json(), { status: post.status })
    return post
  },
  feature: 'encumbrances',
  body: liquidationBody,
  handler: async ({ authz, body }) => {
    const orgId = authz.user.orgId
    const subsidiaryId = await encumbranceSubsidiaryId(orgId, body.encumbranceId)
    if (!subsidiaryId) return notFound('record')
    const denied = guardSubsidiaryScope(authz, subsidiaryId)
    if (denied) return denied
    return NextResponse.json({
      ok: true,
      ...(await linkEncumbranceDocumentLine({
        orgId,
        encumbranceId: body.encumbranceId,
        documentLineId: body.documentLineId,
        actorId: authz.user.id,
      })),
    })
  },
})
