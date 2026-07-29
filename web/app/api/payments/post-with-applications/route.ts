import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  postPaymentWithApplications,
  type AllocationInput,
  type PaymentKind,
} from '@openbooks/engine/src/payments.ts'
import { submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/index.ts'
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
    if (r.rows[0].status === 'draft') {
      const submission = await submitAndReleaseIfUngated(
        r.rows[0].kind,
        body.documentId,
        authz.user.id,
      )
      if (submission.flowError) {
        return NextResponse.json(
          { error: `approval could not be routed: ${submission.flowError}` },
          { status: 422 },
        )
      }
      if (submission.gated) {
        return NextResponse.json(
          { ok: true, pendingApproval: true, requestId: submission.runId },
          { status: 202 },
        )
      }
    } else if (r.rows[0].status !== 'approved') {
      return NextResponse.json(
        { error: `payment is ${r.rows[0].status}; only an approved payment can be posted` },
        { status: 422 },
      )
    }
    const result = await postPaymentWithApplications(body.documentId, body.allocations, authz.user.id)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
