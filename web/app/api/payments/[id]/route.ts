import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/db.ts'
import {
  loadPaymentDocument,
  updateDraftPayment,
  type PaymentKind,
} from '@openbooks/engine/src/payments.ts'
import { deleteDocument, DeleteError } from '@openbooks/engine/src/document-delete.ts'
import { can, getAuthz, guardSubsidiaryScope, type Authz } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { exactMoney, isoDate, nullableUuidId, parseJsonBody } from '../../../../lib/api/json'
import { paymentErrorResponse, paymentPermission } from '../lib'

export const runtime = 'nodejs'

/** One open-item application on a draft payment (engine AllocationInput). */
const allocationInput = z.object({
  openLineId: z.string().min(1),
  /** Amount consumed from the payment/credit source, in the payment currency. */
  sourceTransactionAmount: exactMoney(),
  /** Amount extinguished on the invoice/bill, in the target open-item currency. */
  targetTransactionAmount: exactMoney(),
  /** Optional independently saved target carrying value, revalidated at posting. */
  targetBaseAmount: exactMoney().optional(),
  /** Target-currency units for one source-currency unit. Required cross-currency. */
  settlementRate: z.string().min(1),
  settlementRateSource: z.enum(['same_currency', 'provider', 'manual', 'contractual', 'imported']),
  /** Bank advice, contract, provider observation, or import evidence reference. */
  settlementRateReference: z.string(),
  settlementFxRateId: nullableUuidId.optional(),
})

const paymentPatchBody = z.object({
  partyId: nullableUuidId.optional(),
  bankAccountId: nullableUuidId.optional(),
  documentDate: isoDate().optional(),
  referenceNumber: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  allocations: z.array(allocationInput).optional(),
})

/** Resolve the document's kind, then gate on ap.pay / ar.pay accordingly.
 *  Subsidiary scope is enforced here too, so every verb (GET/PATCH/DELETE)
 *  inherits the same fail-closed record boundary. */
async function gateForDocument(
  id: string,
  orgId: string | null,
): Promise<{ authz: Authz; kind: PaymentKind } | NextResponse> {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const r = (await db.execute<{ kind: PaymentKind; subsidiaryId: string | null }>(sql`
    select kind, subsidiary_id as "subsidiaryId" from documents
     where id = ${id} and kind in ('vendor_payment', 'customer_payment')
       and org_id = ${orgId ?? authz.user.orgId}
  `))
  if (!r.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(authz, r.rows[0].subsidiaryId)
  if (denied) return denied
  const kind = r.rows[0].kind
  const perm = paymentPermission(kind)
  if (!can(authz, perm)) {
    return NextResponse.json({ error: `missing permission: ${perm}` }, { status: 403 })
  }
  return { authz, kind }
}

/**
 * Open-item allocations write against OTHER parties' documents — the targets
 * are record boundaries of their own. Every referenced open line must belong
 * to a document inside the caller's subsidiary scope (and exist in the org).
 */
async function assertAllocationTargetsInScope(
  authz: Authz,
  openLineIds: readonly string[],
): Promise<NextResponse | null> {
  if (!authz.allowedSubsidiaryIds || openLineIds.length === 0) return null
  const rows = (await db.execute<{ id: string; subsidiaryId: string | null }>(sql`
    select dl.id, d.subsidiary_id as "subsidiaryId"
      from document_lines dl
      join documents d on d.id = dl.document_id and d.org_id = dl.org_id
     where dl.id = any(${`{${openLineIds.join(',')}}`}::uuid[]) and dl.org_id = ${authz.user.orgId}
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

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const gate = await gateForDocument(id, null)
  if (gate instanceof NextResponse) return gate
  const payment = await loadPaymentDocument(id, gate.kind, gate.authz.user.orgId)
  if (!payment) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(payment)
}

/** Autosave for draft payments: header fields + open-item allocations. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const gate = await gateForDocument(id, null)
  if (gate instanceof NextResponse) return gate

  const parsed = await parseJsonBody(req, paymentPatchBody, { status: 422 })
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  const allocationTargetsDenied = await assertAllocationTargetsInScope(
    gate.authz,
    (body.allocations ?? []).map((a) => a.openLineId),
  )
  if (allocationTargetsDenied) return allocationTargetsDenied

  try {
    await updateDraftPayment(id, body, gate.authz.user.id, gate.authz.user.orgId)
    const payment = await loadPaymentDocument(id, gate.kind, gate.authz.user.orgId)
    return NextResponse.json(payment)
  } catch (e) {
    return paymentErrorResponse(e)
  }
}

/** Delete a payment/receipt (guarded: open period, no live applications). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const gate = await gateForDocument(id, null)
  if (gate instanceof NextResponse) return gate
  try {
    await deleteDocument(id, gate.authz.user.id, gate.authz.user.orgId)
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof DeleteError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
