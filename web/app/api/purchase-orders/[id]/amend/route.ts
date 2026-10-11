import { z } from 'zod'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { ScopeNotFoundError } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { guardSubsidiaryScope } from '../../../../../lib/authz'
import { unexpectedServerError } from '../../../../../lib/api/unexpected'
import { amendPurchaseOrder, PurchaseOrderAmendError } from '../../../../../lib/purchase-order-amend'

export const runtime = 'nodejs'

const params = z.object({ id: z.string().uuid() })

const amendLineBody = z.object({
  lineId: z.string().uuid(),
  quantity: z.string().min(1).max(50).optional(),
  unitPrice: z.string().min(1).max(50).optional(),
}).strict()

const amendBody = z.object({
  reason: z.string().trim().min(5, 'an amendment reason between 5 and 500 characters is required').max(500),
  expectedUpdatedAt: z.string().min(1).optional(),
  lines: z.array(amendLineBody).min(1),
}).strict()

/**
 * POST amend: change quantity and/or unit price on an approved purchase
 * order's lines when receipts or bills already guard a redraft. Quantities
 * never fall below received or billed evidence; the amendment is audited
 * before/after with its reason, bumps the revision, and re-approves through
 * the native Flow release (ungated it stays approved, gated it goes
 * pending_approval into a new run).
 */
export const POST = defineRoute({
  permission: 'purchase_orders.create',
  feature: 'orders',
  params,
  body: amendBody,
  handler: async ({ authz, params: { id }, body }) => {
    try {
      const outcome = await withOrgTransaction(authz.user.orgId, async () => {
        const locked = (await db.execute<{ subsidiaryId: string | null }>(sql`
          select subsidiary_id as "subsidiaryId" from documents
           where id = ${id} and kind = 'purchase_order' and org_id = ${authz.user.orgId}
           for update
        `))
        if (!locked.rows[0]) return { kind: 'not_found' as const }
        if (guardSubsidiaryScope(authz, locked.rows[0]?.subsidiaryId)) {
          return { kind: 'scope_revoked' as const }
        }
        const result = await amendPurchaseOrder({
          orderId: id,
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          reason: body.reason,
          expectedUpdatedAt: body.expectedUpdatedAt,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          lines: body.lines,
        })
        return { kind: 'amended' as const, result }
      })
      if (outcome.kind === 'not_found' || outcome.kind === 'scope_revoked') {
        return notFound('record')
      }
      return NextResponse.json({ ok: true, status: outcome.result.status, gated: outcome.result.gated, runId: outcome.result.runId })
    } catch (e) {
      if (e instanceof ScopeNotFoundError) return notFound('record')
      if (e instanceof PurchaseOrderAmendError) {
        return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
      }
      return unexpectedServerError('purchase-orders/amend', e)
    }
  },
})
