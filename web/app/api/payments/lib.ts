import { paymentRunScopeSql } from '@/lib/payment-run-access'
import 'server-only'
import { NextResponse } from 'next/server'
import { PaymentError, type PaymentKind } from '@openbooks/engine/src/payments.ts'
import { PostingError } from '@openbooks/engine/src/posting.ts'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { can, getAuthz, guardSubsidiaryScope, type Authz } from '@/lib/authz'

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
 *  may not operate a run whose header or retained source evidence lies
 *  outside their subsidiary scope. The SSR views use this same predicate. */
export async function guardPaymentRunPermission(
  runId: string,
  capability: 'pay' | 'approve' = 'pay',
): Promise<Authz | NextResponse> {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const row = await db.execute<{ direction: string }>(sql`
    select r.direction from payment_runs r
     where r.id = ${runId} and ${paymentRunScopeSql(authz)}
  `)
  const run = row.rows[0]
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const permission = `${run.direction === 'inbound' ? 'ar' : 'ap'}.${capability}`
  if (!can(authz, permission)) return NextResponse.json({ error: `missing permission: ${permission}` }, { status: 403 })
  return authz
}

/**
 * Open-item allocations write against OTHER parties' documents — the targets
 * are record boundaries of their own. Every referenced open line must belong
 * to a document inside the caller's subsidiary scope (and exist in the org).
 */
export async function assertAllocationTargetsInScope(
  authz: Authz,
  openLineIds: readonly string[],
): Promise<NextResponse | null> {
  if (!authz.allowedSubsidiaryIds || openLineIds.length === 0) return null
  const rows = (await db.execute<{ id: string; subsidiaryId: string | null }>(sql`
    select jl.id, jl.subsidiary_id as "subsidiaryId"
      from journal_lines jl
     where jl.id = any(${`{${openLineIds.join(',')}}`}::uuid[]) and jl.org_id = ${authz.user.orgId} and jl.is_open_item
  `))
  const byId = new Map(rows.rows.map((row) => [row.id, row.subsidiaryId]))
  for (const lineId of openLineIds) {
    // An id that does not resolve in this org fails closed the same way —
    // it is indistinguishable from one outside the caller's scope.
    if (!byId.has(lineId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const denied = guardSubsidiaryScope(authz, byId.get(lineId))
    if (denied) return denied
  }
  return null
}
