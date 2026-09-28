import { defineRoute } from '@/lib/api/route'
import { uuidId } from '../../../../lib/api/json'
import { guardPermission } from '../../../../lib/authz'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  amendGrant,
  awardGrant,
  recognizeGrantDrawdown,
  recordGrantDrawdown,
  voidGrant,
  voidGrantDrawdown,
} from '@openbooks/engine/src/nonprofit/grants.ts'

export const runtime = 'nodejs'

const postingAccounts = z.strictObject({
  bankAccountId: uuidId,
  grantsReceivableAccountId: uuidId,
  refundableAdvanceAccountId: uuidId,
  grantRevenueAccountId: uuidId,
  exchangeReceivableAccountId: uuidId,
  exchangeRevenueAccountId: uuidId,
})

/**
 * Posting grant commands. Both grants.manage and gl.post are proven in
 * authorize() — before the feature check, the scope check, and the body
 * parse — because every action here posts or reverses a journal. The
 * non-posting lifecycle lives on the sibling commands route under
 * grants.manage alone.
 */
const grantPostingBody = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('award'),
    grantId: uuidId,
    accounts: postingAccounts,
    postingDate: z.string(),
  }),
  z.strictObject({
    action: z.literal('recordDrawdown'),
    grantId: uuidId,
    drawdownId: uuidId.optional(),
    amount: z.string(),
    kind: z.enum(['advance', 'reimbursement', 'final']),
    accounts: postingAccounts,
    postingDate: z.string(),
  }),
  z.strictObject({
    action: z.literal('recognizeDrawdown'),
    drawdownId: uuidId,
    grantRevenueAccountId: uuidId,
    refundableAdvanceAccountId: uuidId,
    postingDate: z.string(),
  }),
  z.strictObject({
    action: z.literal('amend'),
    grantId: uuidId,
    reason: z.string(),
    changes: z.strictObject({
      name: z.string().optional(),
      sponsorPartyId: uuidId.optional(),
      sponsorKind: z.enum(['government', 'foundation', 'corporate']).optional(),
      determination: z.enum(['contribution_unconditional', 'contribution_conditional', 'exchange']).optional(),
      barrier: z.string().nullable().optional(),
      rightOfReturn: z.boolean().optional(),
      awardAmount: z.string().optional(),
      periodFrom: z.string().optional(),
      periodTo: z.string().optional(),
      indirectRate: z.string().optional(),
      indirectBase: z.enum(['direct_costs', 'modified_total_direct']).optional(),
      costShareRequired: z.boolean().optional(),
      costShareAmount: z.string().optional(),
      fundId: uuidId.optional(),
      allowableAccountGroupId: uuidId.optional(),
    }),
    accounts: postingAccounts,
    postingDate: z.string(),
  }),
  z.strictObject({
    action: z.literal('void'),
    grantId: uuidId,
    postingDate: z.string(),
    reason: z.string(),
  }),
  z.strictObject({
    action: z.literal('voidDrawdown'),
    drawdownId: uuidId,
    postingDate: z.string(),
    reason: z.string(),
  }),
])

export const POST = defineRoute({
  authorize: async () => {
    // Normalize every denial to a real NextResponse: the factory answers
    // `instanceof NextResponse`, and a data-URL session double cannot name
    // next/server — Response is the portable base both share, so the status
    // and body survive the trip either way.
    const manage = await guardPermission('grants.manage')
    if (manage instanceof Response) return NextResponse.json(await manage.json(), { status: manage.status })
    const post = await guardPermission('gl.post')
    if (post instanceof Response) return NextResponse.json(await post.json(), { status: post.status })
    return post
  },
  feature: 'grantManagement',
  scope: 'unrestricted',
  body: grantPostingBody,
  handler: async ({ authz, body }) => {
    const orgId = authz.user.orgId
    const actorId = authz.user.id
    switch (body.action) {
      case 'award':
        return NextResponse.json({
          ok: true,
          ...(await awardGrant({ orgId, grantId: body.grantId, accounts: body.accounts, postingDate: body.postingDate, actorId })),
        })
      case 'recordDrawdown':
        return NextResponse.json({
          ok: true,
          ...(await recordGrantDrawdown({
            orgId,
            grantId: body.grantId,
            drawdownId: body.drawdownId,
            amount: body.amount,
            kind: body.kind,
            accounts: body.accounts,
            postingDate: body.postingDate,
            actorId,
          })),
        })
      case 'recognizeDrawdown':
        return NextResponse.json({
          ok: true,
          ...(await recognizeGrantDrawdown({
            orgId,
            drawdownId: body.drawdownId,
            grantRevenueAccountId: body.grantRevenueAccountId,
            refundableAdvanceAccountId: body.refundableAdvanceAccountId,
            postingDate: body.postingDate,
            actorId,
          })),
        })
      case 'amend':
        return NextResponse.json({
          ok: true,
          grant: await amendGrant({
            orgId,
            grantId: body.grantId,
            reason: body.reason,
            changes: body.changes,
            accounts: body.accounts,
            postingDate: body.postingDate,
            actorId,
          }),
        })
      case 'void':
        return NextResponse.json({
          ok: true,
          grant: await voidGrant({ orgId, grantId: body.grantId, postingDate: body.postingDate, reason: body.reason, actorId }),
        })
      case 'voidDrawdown':
        await voidGrantDrawdown({ orgId, drawdownId: body.drawdownId, postingDate: body.postingDate, reason: body.reason, actorId })
        return NextResponse.json({ ok: true })
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
  },
})
