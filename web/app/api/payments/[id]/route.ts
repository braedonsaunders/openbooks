import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  loadPaymentDocument,
  updateDraftPayment,
  type AllocationInput,
  type PaymentKind,
} from '@openbooks/engine/src/payments.ts'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { deleteDocument, DeleteError } from '@openbooks/engine/src/document-delete.ts'
import { can, getAuthz, type Authz } from '../../../../lib/authz'
import { canonicalDecimal } from '../../../../lib/exact-decimal'
import { isUuid } from '../../../../lib/list-params'
import { paymentErrorResponse, paymentPermission } from '../lib'

export const runtime = 'nodejs'

/** Exact numeric(19,4) money string, or 'invalid'. */
function exactMoney(v: unknown): string | 'invalid' {
  const exact = canonicalDecimal(v, 4)
  if (exact === null) return 'invalid'
  try {
    return normalizeMoney(exact)
  } catch {
    return 'invalid'
  }
}

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

  const body = (await req.json()) as {
    partyId?: string | null
    bankAccountId?: string | null
    documentDate?: string
    referenceNumber?: string | null
    memo?: string | null
    allocations?: AllocationInput[]
  }

  let allocations = body.allocations
  if (allocations !== undefined) {
    if (!Array.isArray(allocations)) {
      return NextResponse.json({ error: 'allocation amounts must be exact decimals' }, { status: 422 })
    }
    const exact: AllocationInput[] = []
    for (const allocation of allocations) {
      const sourceTransactionAmount = exactMoney(allocation?.sourceTransactionAmount)
      const targetTransactionAmount = exactMoney(allocation?.targetTransactionAmount)
      const targetBaseAmount = allocation?.targetBaseAmount === undefined
        ? undefined
        : exactMoney(allocation.targetBaseAmount)
      if (
        sourceTransactionAmount === 'invalid' ||
        targetTransactionAmount === 'invalid' ||
        targetBaseAmount === 'invalid'
      ) {
        return NextResponse.json({ error: 'allocation amounts must be exact decimals' }, { status: 422 })
      }
      exact.push({
        ...allocation,
        sourceTransactionAmount,
        targetTransactionAmount,
        ...(targetBaseAmount === undefined ? {} : { targetBaseAmount }),
      })
    }
    allocations = exact
  }

  try {
    await updateDraftPayment(id, { ...body, allocations }, gate.authz.user.id, gate.authz.user.orgId)
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
