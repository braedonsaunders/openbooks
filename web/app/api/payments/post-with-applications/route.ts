import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { PaymentRevisionConflictError } from "@openbooks/engine/src/payments/payment-errors.ts";
import { postPaymentWithApplications } from "@openbooks/engine/src/payments/payment-posting.ts";
import { updateDraftPayment } from "@openbooks/engine/src/payments/payment-documents.ts";
import { type PaymentKind } from "@openbooks/engine/src/payments/payment-contracts.ts";
import { submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/index.ts'
import { runPostDocumentEffects } from "@openbooks/engine/src/ledger/posting-dispatch.ts";
import { can, getAuthz, guardSubsidiaryScope } from '../../../../lib/authz'
import { DocumentEditError, requireDocumentEditRevision } from "../../../../../engine/src/records/document-edit-policy.ts";
import { exactMoney, nullableUuidId, parseJsonBody, uuidId } from '../../../../lib/api/json'
import { assertAllocationTargetsInScope, paymentErrorResponse, paymentPermission } from '../lib'

export const runtime = 'nodejs'

/** One open-item application (engine AllocationInput), shape-checked here;
 *  cross-field rules stay in the engine's posting kernel. */
const allocationInput = z.object({
  openLineId: z.string().min(1),
  sourceTransactionAmount: exactMoney(),
  targetTransactionAmount: exactMoney(),
  targetBaseAmount: exactMoney().optional(),
  settlementRate: z.string().min(1),
  settlementRateSource: z.enum(['same_currency', 'provider', 'manual', 'contractual', 'imported']),
  settlementRateReference: z.string(),
  settlementFxRateId: nullableUuidId.optional(),
})

const postWithApplicationsBody = z.object({
  documentId: z.string({ error: 'documentId is required' }).refine(
    (v) => uuidId.safeParse(v).success,
    'documentId is required',
  ),
  /** Optimistic concurrency token from documents.revision_seq (exact form). */
  expectedUpdatedAt: z.string().optional(),
  allocations: z.array(allocationInput).optional(),
})

/**
 * Explicit "Pay & post": posts the payment document through the kernel and
 * applies it to the selected open items atomically (auto-reversal on
 * application failure — see engine/src/payments/payments.ts).
 */
export async function POST(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const parsed = await parseJsonBody(req, postWithApplicationsBody)
  if (!parsed.ok) return parsed.response
  const { documentId, allocations } = parsed.data

  const r = (await db.execute<{ kind: PaymentKind; status: string; subsidiaryId: string | null }>(sql`
    select kind, status, subsidiary_id as "subsidiaryId" from documents
     where id = ${documentId} and kind in ('vendor_payment', 'customer_payment')
       and org_id = ${authz.user.orgId}
  `))
  if (!r.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const scopeDenied = guardSubsidiaryScope(authz, r.rows[0].subsidiaryId)
  if (scopeDenied) return scopeDenied
  const targetsDenied = await assertAllocationTargetsInScope(authz, (allocations ?? []).map(item => item.openLineId))
  if (targetsDenied) return targetsDenied
  const perm = paymentPermission(r.rows[0].kind)
  if (!can(authz, perm)) {
    return NextResponse.json({ error: `missing permission: ${perm}` }, { status: 403 })
  }
  // Mandatory optimistic-concurrency evidence — same contract as
  // PATCH /api/payments/[id]: the draft branch below saves the final
  // allocation set while the document is still draft, so a stale caller
  // must 409 here instead of silently overwriting a newer allocation set
  // that approval then reviews and posts. Checked after the gates so a
  // missing token never leaks document existence to an unauthorized caller.
  let expectedRevision: string
  try {
    expectedRevision = requireDocumentEditRevision(parsed.data.expectedUpdatedAt)
  } catch (e) {
    if (e instanceof DocumentEditError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
  }

  try {
    const outcome = await withOrgTransaction(authz.user.orgId, async () => {
      // Draft save already locks allocation books; take the posting aggregate
      // fence before that save and before the document row, not only in the kernel.
      await db.execute(sql`select id from orgs where id = ${authz.user.orgId} for update`)

      const locked = (await db.execute<{ kind: PaymentKind; status: string }>(sql`
        select kind, status from documents
         where id = ${documentId} and org_id = ${authz.user.orgId}
           and kind in ('vendor_payment', 'customer_payment')
         for update
      `))
      const payment = locked.rows[0]
      if (!payment) return { kind: 'not_found' as const }
      const previousStatus = payment.status
      if (previousStatus === 'draft') {
        // The posting body is a convenience for the drawer's final action,
        // not an unpersisted approval bypass. Save it while the document is
        // still draft so the exact allocation set is what approval reviews.
        if (allocations !== undefined) {
          await updateDraftPayment(
            documentId,
            { allocations },
            authz.user.id,
            authz.user.orgId,
            // The OCC token is route-level evidence; it never enters the
            // engine's financial patch shape.
            { expectedRevision },
          )
        }
        const submission = await submitAndReleaseIfUngated(
          payment.kind,
          documentId,
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
        documentId,
        allocations,
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
    await runPostDocumentEffects(documentId, outcome.previousStatus)
    return NextResponse.json({ ok: true, ...outcome.result })
  } catch (e) {
    // The engine fence fired under the row lock: someone saved first.
    if (e instanceof PaymentRevisionConflictError) {
      return NextResponse.json({ error: e.message }, { status: 409 })
    }
    return paymentErrorResponse(e)
  }
}
