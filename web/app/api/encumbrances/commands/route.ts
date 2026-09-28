import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { uuidId } from '../../../../lib/api/json'
import { guardSubsidiaryScope, subsidiariesInScope } from '../../../../lib/authz'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  closeEncumbrance,
  createEncumbrance,
  encumbranceSubsidiaryId,
  voidEncumbrance,
} from '@openbooks/engine/src/nonprofit/encumbrances.ts'

export const runtime = 'nodejs'

/**
 * Non-posting encumbrance commands. Route-level encumbrances.manage is proven
 * before the body parses; subsidiary scope is enforced per record against the
 * stored subsidiary, and creation refuses a subsidiary outside the caller's
 * scope. Linking actuals (liquidation) lives on the sibling liquidations
 * route, which additionally proves gl.post.
 */
const encumbranceCommandBody = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create'),
    sourceKind: z.enum(['purchase_order', 'manual']),
    sourceId: uuidId.optional(),
    amount: z.string(),
    accountId: uuidId,
    subsidiaryId: uuidId,
    departmentId: uuidId.optional(),
    projectId: uuidId.optional(),
    locationId: uuidId.optional(),
    classId: uuidId.optional(),
    fundId: uuidId,
  }),
  z.strictObject({ action: z.literal('close'), encumbranceId: uuidId, reason: z.string() }),
  z.strictObject({ action: z.literal('void'), encumbranceId: uuidId, reason: z.string() }),
])

export const POST = defineRoute({
  permission: 'encumbrances.manage',
  feature: 'encumbrances',
  body: encumbranceCommandBody,
  handler: async ({ authz, body }) => {
    const orgId = authz.user.orgId
    const actorId = authz.user.id
    switch (body.action) {
      case 'create': {
        if (!subsidiariesInScope(authz, [body.subsidiaryId])) return notFound('record')
        return NextResponse.json({
          ok: true,
          ...(await createEncumbrance({
            orgId,
            sourceKind: body.sourceKind,
            sourceId: body.sourceId,
            amount: body.amount,
            accountId: body.accountId,
            subsidiaryId: body.subsidiaryId,
            departmentId: body.departmentId,
            projectId: body.projectId,
            locationId: body.locationId,
            classId: body.classId,
            extraDims: { fund: body.fundId },
            actorId,
          })),
        })
      }
      case 'close': {
        // The stored subsidiary gates the change: missing, cross-org, or
        // out-of-scope reads answer the uniform 404.
        const subsidiaryId = await encumbranceSubsidiaryId(orgId, body.encumbranceId)
        if (!subsidiaryId) return notFound('record')
        const denied = guardSubsidiaryScope(authz, subsidiaryId)
        if (denied) return denied
        await closeEncumbrance({ orgId, encumbranceId: body.encumbranceId, reason: body.reason, actorId })
        return NextResponse.json({ ok: true })
      }
      case 'void': {
        const subsidiaryId = await encumbranceSubsidiaryId(orgId, body.encumbranceId)
        if (!subsidiaryId) return notFound('record')
        const denied = guardSubsidiaryScope(authz, subsidiaryId)
        if (denied) return denied
        await voidEncumbrance({ orgId, encumbranceId: body.encumbranceId, reason: body.reason, actorId })
        return NextResponse.json({ ok: true })
      }
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
  },
})
