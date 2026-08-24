import 'server-only'
import { NextResponse } from 'next/server'
import { PaymentError, type PaymentKind } from '@openbooks/engine/src/payments.ts'
import { PostingError } from '@openbooks/engine/src/posting.ts'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { can, getAuthz, type Authz } from '@/lib/authz'

/** ap.pay for vendor payments, ar.pay for customer receipts. */
export function paymentPermission(kind: PaymentKind): 'ap.pay' | 'ar.pay' {
  return kind === 'vendor_payment' ? 'ap.pay' : 'ar.pay'
}

export function isPaymentKind(kind: unknown): kind is PaymentKind {
  return kind === 'vendor_payment' || kind === 'customer_payment'
}

/** Uniform error mapping: domain errors are 422, everything else 500. */
export function paymentErrorResponse(e: unknown): NextResponse {
  const status = e instanceof PaymentError || e instanceof PostingError ? 422 : 500
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status })
}

/** Authorize a run by its actual direction, not by which page called it.
 *  The run's record boundary is the set of bills it pays: a restricted caller
 *  may not operate a run whose live items touch a source document outside
 *  their subsidiary scope (null-subsidiary sources fail closed). */
export async function guardPaymentRunPermission(
  runId: string,
  capability: 'pay' | 'approve' = 'pay',
): Promise<Authz | NextResponse> {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const row = (await db.execute<{ direction: string }>(sql`select direction from payment_runs where id = ${runId} and org_id = ${authz.user.orgId}`))
  const run = row.rows[0]
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (authz.allowedSubsidiaryIds) {
    const ids = [...authz.allowedSubsidiaryIds]
    // Empty scope denies any run with live items at all.
    const outsidePredicate = ids.length === 0
      ? sql`true`
      : sql`(d.subsidiary_id is null or not (d.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[])))`
    const outside = (await db.execute(sql`
      select d.id
        from payment_run_items ri
        join documents d on d.id = ri.source_document_id and d.org_id = ri.org_id
       where ri.payment_run_id = ${runId} and ri.org_id = ${authz.user.orgId}
         and ri.status <> 'cancelled'
         and ${outsidePredicate}
       limit 1
    `))
    if (outside.rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const permission = `${run.direction === 'inbound' ? 'ar' : 'ap'}.${capability}`
  if (!can(authz, permission)) return NextResponse.json({ error: `missing permission: ${permission}` }, { status: 403 })
  return authz
}
