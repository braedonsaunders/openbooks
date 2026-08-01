import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import {
  postPaymentWithApplications,
  type AllocationInput,
  type PaymentKind,
} from '@openbooks/engine/src/payments.ts'
import { submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/index.ts'
import { runPostDocumentEffects } from '@openbooks/engine/src/posting.ts'
import { can, getAuthz } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { paymentErrorResponse, paymentPermission } from '../lib'

export const runtime = 'nodejs'

/**
 * Explicit "Pay & post": posts the payment document through the kernel and
 * applies it to the selected open items atomically (auto-reversal on
 * application failure — see engine/src/payments.ts).
 */
export async function POST(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await req.json()) as { documentId?: string; allocations?: AllocationInput[] }
  if (!body.documentId || !isUuid(body.documentId)) {
    return NextResponse.json({ error: 'documentId is required' }, { status: 400 })
  }

  const r = (await db.execute(sql`
    select kind, status from documents
     where id = ${body.documentId} and kind in ('vendor_payment', 'customer_payment')
       and org_id = ${authz.user.orgId}
  `)) as unknown as { rows: { kind: PaymentKind; status: string }[] }
  if (!r.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const perm = paymentPermission(r.rows[0].kind)
  if (!can(authz, perm)) {
    return NextResponse.json({ error: `missing permission: ${perm}` }, { status: 403 })
  }

  try {
    const outcome = await withOrgTransaction(authz.user.orgId, async () => {
      const locked = (await db.execute(sql`
        select kind, status from documents
         where id = ${body.documentId} and org_id = ${authz.user.orgId}
           and kind in ('vendor_payment', 'customer_payment')
         for update
      `)) as unknown as { rows: Array<{ kind: PaymentKind; status: string }> }
      const payment = locked.rows[0]
      if (!payment) return { kind: 'not_found' as const }
      const previousStatus = payment.status
      if (previousStatus === 'draft') {
        const submission = await submitAndReleaseIfUngated(
          payment.kind,
          body.documentId!,
          authz.user.id,
        )
        if (submission.flowError) {
          return { kind: 'flow_error' as const, error: submission.flowError }
        }
        if (submission.gated) {
          return { kind: 'pending' as const, requestId: submission.runId }
        }
      } else if (previousStatus !== 'approved') {
        return { kind: 'invalid_status' as const, status: previousStatus }
      }
      const result = await postPaymentWithApplications(
        body.documentId!,
        body.allocations,
        authz.user.id,
        'ui',
        { deferEffects: true },
      )
      return { kind: 'posted' as const, result, previousStatus }
    })
    if (outcome.kind === 'not_found') {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    if (outcome.kind === 'flow_error') {
      return NextResponse.json(
        { error: `approval could not be routed: ${outcome.error}` },
        { status: 422 },
      )
    }
    if (outcome.kind === 'pending') {
      return NextResponse.json(
        { ok: true, pendingApproval: true, requestId: outcome.requestId },
        { status: 202 },
      )
    }
    if (outcome.kind === 'invalid_status') {
      return NextResponse.json(
        { error: `payment is ${outcome.status}; only an approved payment can be posted` },
        { status: 422 },
      )
    }
    await runPostDocumentEffects(body.documentId, outcome.previousStatus)
    return NextResponse.json({ ok: true, ...outcome.result })
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
