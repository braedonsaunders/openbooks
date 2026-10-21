import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { invoiceWriteOffSubject } from '@/lib/posting-review-subjects'
import { InvoiceWriteOffConflictError, writeOffInvoice } from '@openbooks/engine/payments/documents'
import { DocumentEditError } from '@openbooks/engine/records/document-edit-policy'
import { ScopeNotFoundError } from '@openbooks/engine/organization/scope'
import { exactMoney, isoDate, parseJsonBody, uuidId } from '@/lib/api/json'
import { guardPermission, guardSubsidiaryScope } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { paymentErrorResponse } from '../lib'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'

export const runtime = 'nodejs'

/**
 * Write off the open balance of a posted customer invoice. The engine posts a
 * customer credit memo on the write-off account and settles the invoice with
 * it, in one transaction. Creating and posting the credit needs ar.post; the
 * settlement needs ar.pay. The Idempotency-Key is required so a retried submit
 * resolves to the write-off it already recorded and never posts a second one.
 */
const writeOffBody = z.object({
  invoiceId: uuidId,
  amount: exactMoney(),
  date: isoDate(),
  reason: z.string().trim().min(1, 'a reason is required: state why the balance is uncollectible').max(500),
})

async function postWriteOff(request: Request) {
  const idempotencyKey = request.headers.get('Idempotency-Key') ?? ''
  if (!isUuid(idempotencyKey)) {
    return NextResponse.json(
      { error: 'an Idempotency-Key header with a UUID is required, so a retried write-off cannot post twice' },
      { status: 400 },
    )
  }
  const parsed = await parseJsonBody(request, writeOffBody)
  if (!parsed.ok) return parsed.response
  const gate = await guardPermission('ar.post')
  if (gate instanceof NextResponse) return gate
  const createGate = await guardPermission('ar.create')
  if (createGate instanceof NextResponse) return createGate
  const settleGate = await guardPermission('ar.pay')
  if (settleGate instanceof NextResponse) return settleGate

  // The invoice is read before any write so a record the caller cannot see
  // answers with the uniform 404, and a subsidiary outside the caller's scope
  // never reaches the engine.
  const invoice = await invoiceWriteOffSubject(gate.user.orgId, parsed.data.invoiceId)
  if (!invoice) return notFound('record')
  const denied = guardSubsidiaryScope(gate, invoice.subsidiaryId)
  if (denied) return denied

  try {
    const result = await writeOffInvoice(
      gate.user.orgId,
      gate.user.id,
      {
        invoiceId: parsed.data.invoiceId,
        amount: parsed.data.amount,
        date: parsed.data.date,
        reason: parsed.data.reason,
        idempotencyKey,
      },
      gate.allowedSubsidiaryIds,
    )
    return NextResponse.json(result, { status: result.status === 'written_off' ? 201 : 200 })
  } catch (error) {
    if (error instanceof ScopeNotFoundError) return notFound('record')
    // A reused key with a changed payload, or a key owned by another tenant,
    // never returns the earlier write-off as though it matched.
    if (error instanceof InvoiceWriteOffConflictError) return apiErrorResponse(error, { safeStatus: 409 })
    if (error instanceof DocumentEditError) {
      if (error.status === 404 && error.message === 'not found') return notFound('record')
      return apiErrorResponse(error, { details: error.fieldErrors ? { fieldErrors: error.fieldErrors } : undefined })
    }
    return paymentErrorResponse(error)
  }
}

const writeOffFeature = { none: 'Invoice write-offs are gated by the AR create, post and pay permissions.' } as const
export const POST = defineRoute({
  authorize: () => guardPermission('ar.post'),
  feature: writeOffFeature,
  handler: async ({ request }) => postWriteOff(request),
})
