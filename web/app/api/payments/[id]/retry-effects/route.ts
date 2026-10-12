import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/platform/db'
import { assertAnyPermission, ScopeNotFoundError } from '@openbooks/engine/organization/scope'
import { replayTerminalPostingEffect, PostingEffectsReplayError } from '@openbooks/engine/ledger/posting-effects'
import { loadPaymentDocument } from '@openbooks/engine/payments/payment-queries'
import type { PaymentKind } from '@openbooks/engine/payments/payment-contracts'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { uuidId } from '@/lib/api/json'
import { notFound } from '@/lib/api/responses'
import { can, getAuthz, guardSubsidiaryScope } from '@/lib/authz'
import { paymentPermission } from '../../lib'

export const runtime = 'nodejs'

/** Effect recovery queues the native outbox; it cannot submit, re-post or
 * change a payment's journal, allocation workpaper or lifecycle. */
export const POST = defineRoute({
  authorize: async () => {
    const authz = await getAuthz()
    if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    try { assertAnyPermission(permission => can(authz, permission), ['ar.pay', 'ap.pay']) }
    catch (error) { if (error instanceof ScopeNotFoundError) return notFound('record'); throw error }
    return authz
  },
  feature: 'banking',
  params: z.object({ id: uuidId }),
  body: z.object({ reason: z.string().trim().min(10).max(1000) }).strict(),
  handler: async ({ authz, params, body }) => {
    try {
      return await withOrgTransaction(authz.user.orgId, async () => {
        const payment = (await db.execute<{ kind: PaymentKind; subsidiary_id: string | null }>(sql`
          select kind, subsidiary_id from documents where org_id = ${authz.user.orgId} and id = ${params.id}
            and kind in ('customer_payment', 'vendor_payment')`)).rows[0]
        if (!payment || !can(authz, paymentPermission(payment.kind))) return notFound('record')
        const denied = guardSubsidiaryScope(authz, payment.subsidiary_id)
        if (denied) return denied
        const effect = (await db.execute<{ id: string }>(sql`select id from posting_effects
          where org_id = ${authz.user.orgId} and document_id = ${params.id}`)).rows[0]
        if (!effect) return notFound('record')
        // The kernel locks effect → document → live actor authority. It
        // rechecks requested scope, current duty, Banking and posted status
        // before the reasoned reset; no document-first lock inversion here.
        await replayTerminalPostingEffect({ orgId: authz.user.orgId, id: effect.id, actorId: authz.user.id,
          reason: body.reason, allowedSubsidiaryIds: authz.allowedSubsidiaryIds })
        const updated = await loadPaymentDocument(params.id, payment.kind, authz.user.orgId, authz.allowedSubsidiaryIds)
        if (!updated) throw new ScopeNotFoundError()
        return NextResponse.json({ payment: updated })
      })
    } catch (error) {
      if (error instanceof ScopeNotFoundError || (error instanceof PostingEffectsReplayError && error.cause instanceof ScopeNotFoundError)) {
        return notFound('record')
      }
      if (error instanceof PostingEffectsReplayError) return apiErrorResponse(error, { safeStatus: 422 })
      throw error
    }
  },
})
