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
import { can, getAuthz, type Authz } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { exactMoney, isoDate, nullableUuidId, parseJsonBody } from '../../../../lib/api/json'
import { paymentErrorResponse, paymentPermission } from '../lib'

export const runtime = 'nodejs'

/** One open-item application on a draft payment (engine AllocationInput). */
const allocationInput = z.object({
  openLineId: z.string().min(1),
  /** Amount consumed from the payment/credit source, in the payment currency. */
  sourceTransactionAmount: exactMoney,
  /** Amount extinguished on the invoice/bill, in the target open-item currency. */
  targetTransactionAmount: exactMoney,
  /** Optional independently saved target carrying value, revalidated at posting. */
  targetBaseAmount: exactMoney.optional(),
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

/** Resolve the document's kind, then gate on ap.pay / ar.pay accordingly. */
async function gateForDocument(
  id: string,
  orgId: string | null,
): Promise<{ authz: Authz; kind: PaymentKind } | NextResponse> {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const r = (await db.execute<{ kind: PaymentKind }>(sql`
    select kind from documents
     where id = ${id} and kind in ('vendor_payment', 'customer_payment')
       and org_id = ${orgId ?? authz.user.orgId}
  `))
  if (!r.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
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

/** Autosave for draft payments: header fields + open-item allocations. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const gate = await gateForDocument(id, null)
  if (gate instanceof NextResponse) return gate

  const parsed = await parseJsonBody(req, paymentPatchBody, { status: 422 })
  if (!parsed.ok) return parsed.response
  const body = parsed.data

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
