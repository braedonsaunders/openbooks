import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/db.ts'
import {
  loadPaymentDocument,
  PaymentRevisionConflictError,
  updateDraftPayment,
  type PaymentKind,
} from '@openbooks/engine/src/payments.ts'
import { deleteDocument, DeleteError } from '@openbooks/engine/src/document-delete.ts'
import { can, getAuthz, guardSubsidiaryScope, type Authz } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import {
  DocumentEditError,
  requireDocumentEditRevision,
} from '../../../../lib/documents'
import { exactMoney, isoDate, nullableUuidId, parseJsonBody } from '../../../../lib/api/json'
import { paymentErrorResponse, assertAllocationTargetsInScope, paymentPermission } from '../lib'

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
  /** Optimistic concurrency token from documents.updated_at (exact form). */
  expectedUpdatedAt: z.string().optional(),
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

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const gate = await gateForDocument(id, null)
  if (gate instanceof NextResponse) return gate
  const payment = await loadPaymentDocument(id, gate.kind, gate.authz.user.orgId)
  if (!payment) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(payment)
}

/** Autosave for draft payments: header fields + open-item allocations.
 *
 * Saves are fenced by the document's exact revision: the caller echoes the
 * `updated_at` token it loaded, and the engine writes only when that token
 * still matches the row locked FOR UPDATE inside the write transaction — so
 * two concurrent saves can never silently overwrite one another. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const gate = await gateForDocument(id, null)
  if (gate instanceof NextResponse) return gate

  const parsed = await parseJsonBody(req, paymentPatchBody, { status: 422 })
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  // Mandatory optimistic-concurrency evidence — same contract as /api/documents/[id].
  let expectedRevision: string
  try {
    expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt)
  } catch (e) {
    if (e instanceof DocumentEditError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
  }
  const allocationTargetsDenied = await assertAllocationTargetsInScope(
    gate.authz,
    (body.allocations ?? []).map((a) => a.openLineId),
  )
  if (allocationTargetsDenied) return allocationTargetsDenied

  try {
    const payment = await updateDraftPayment(
      id,
      {
        partyId: body.partyId,
        bankAccountId: body.bankAccountId,
        documentDate: body.documentDate,
        referenceNumber: body.referenceNumber,
        memo: body.memo,
        allocations: body.allocations,
      },
      gate.authz.user.id,
      gate.authz.user.orgId,
      // The OCC token is route-level evidence; it never enters the engine's
      // financial patch shape.
      { expectedRevision },
    )
    return NextResponse.json(payment)
  } catch (e) {
    // The engine fence fired under the row lock: someone saved first.
    if (e instanceof PaymentRevisionConflictError) {
      return NextResponse.json({ error: e.message }, { status: 409 })
    }
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
