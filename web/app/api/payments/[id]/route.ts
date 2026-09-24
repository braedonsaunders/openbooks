import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { loadPaymentDocument } from "@openbooks/engine/src/payments/payment-queries.ts";
import { PaymentRevisionConflictError } from "@openbooks/engine/src/payments/payment-errors.ts";
import { updateDraftPayment } from "@openbooks/engine/src/payments/payment-documents.ts";
import { type PaymentKind } from "@openbooks/engine/src/payments/payment-contracts.ts";
import { deleteDocument, DeleteError } from '@openbooks/engine/src/ledger/document-delete.ts'
import { assertAnyPermission, ScopeNotFoundError } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { can, getAuthz, guardSubsidiaryScope, type Authz } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { DocumentEditError, requireDocumentEditRevision } from "../../../../../engine/src/records/document-edit-policy.ts";
import { exactMoney, isoDate, nullableUuidId, parseJsonBody, uuidId } from '../../../../lib/api/json'
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
  /** Optimistic concurrency token from documents.revision_seq (exact form). */
  expectedUpdatedAt: z.string().optional(),
  partyId: nullableUuidId.optional(),
  bankAccountId: nullableUuidId.optional(),
  documentDate: isoDate().optional(),
  referenceNumber: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  allocations: z.array(allocationInput).optional(),
  // Credit-memo applications (engine CreditAllocationInput). The engine
  // validates endpoints, signs, and capacity at save and at posting; the
  // route only shapes them. Without this field a receipt can never apply a
  // credit memo through the product API.
  creditAllocations: z.array(z.object({
    fromLineId: uuidId,
    toLineId: uuidId,
    amount: exactMoney(),
    sourceDocumentId: uuidId,
  })).optional(),
})

/** Resolve the document's kind, then gate on ap.pay / ar.pay accordingly.
 *  Permission before existence (canonical shape 4 in
 *  engine/src/organization/subsidiary-scope.ts): a caller holding neither
 *  ap.pay nor ar.pay learns nothing — existing and missing ids answer the
 *  same uniform 404. Subsidiary scope is enforced here too, so every verb
 *  (GET/PATCH/DELETE) inherits the same fail-closed record boundary. */
async function gateForDocument(
  id: string,
  orgId: string | null,
): Promise<{ authz: Authz; kind: PaymentKind } | NextResponse> {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    assertAnyPermission((permission) => can(authz, permission), ['ap.pay', 'ar.pay'])
  } catch (error) {
    if (error instanceof ScopeNotFoundError) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    throw error
  }
  const r = (await db.execute<{ kind: PaymentKind; subsidiaryId: string | null }>(sql`
    select kind, subsidiary_id as "subsidiaryId" from documents
     where id = ${id} and kind in ('vendor_payment', 'customer_payment')
       and org_id = ${orgId ?? authz.user.orgId}
  `))
  if (!r.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(authz, r.rows[0].subsidiaryId)
  if (denied) return denied
  const kind = r.rows[0].kind
  // Wrong-direction callers learn nothing either: the kind-specific
  // permission fails closed with the same uniform 404, so an ap.pay-only
  // caller cannot distinguish an existing customer receipt from a missing id.
  const perm = paymentPermission(kind)
  if (!can(authz, perm)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
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
    [
      ...(body.allocations ?? []).map((a) => a.openLineId),
      ...(body.creditAllocations ?? []).flatMap((a) => [a.fromLineId, a.toLineId]),
    ],
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
        creditAllocations: body.creditAllocations,
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
    await deleteDocument(id, gate.authz.user.id, gate.authz.user.orgId, {
      allowedSubsidiaryIds: gate.authz.allowedSubsidiaryIds,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof ScopeNotFoundError) return NextResponse.json({ error: "not found" }, { status: 404 })
    if (e instanceof DeleteError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
