import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import {
  postPaymentWithApplications,
  updateDraftPayment,
  type PaymentKind,
} from '@openbooks/engine/src/payments.ts'
import { submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/index.ts'
import { runPostDocumentEffects } from '@openbooks/engine/src/posting.ts'
import { can, getAuthz, guardSubsidiaryScope } from '../../../../lib/authz'
import { exactMoney, nullableUuidId, parseJsonBody, uuidId } from '../../../../lib/api/json'
import { paymentErrorResponse, paymentPermission } from '../lib'

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
  allocations: z.array(allocationInput).optional(),
})

/**
 * Explicit "Pay & post": posts the payment document through the kernel and
 * applies it to the selected open items atomically (auto-reversal on
 * application failure — see engine/src/payments.ts).
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
  // Applied open items are record boundaries of their own — every referenced
  // line must resolve to a document inside the caller's subsidiary scope.
  {
    const openLineIds = (allocations ?? []).map((a) => a.openLineId)
    if (authz.allowedSubsidiaryIds && openLineIds.length) {
      const targets = (await db.execute<{ id: string; subsidiaryId: string | null }>(sql`
        select dl.id, d.subsidiary_id as "subsidiaryId"
          from document_lines dl
          join documents d on d.id = dl.document_id and d.org_id = dl.org_id
         where dl.id = any(${`{${openLineIds.join(',')}}`}::uuid[]) and dl.org_id = ${authz.user.orgId}
      `))
      const byId = new Map(targets.rows.map((row) => [row.id, row.subsidiaryId]))
      for (const lineId of openLineIds) {
        if (!byId.has(lineId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
        const denied = guardSubsidiaryScope(authz, byId.get(lineId))
        if (denied) return denied
      }
    }
  }
  const perm = paymentPermission(r.rows[0].kind)
  if (!can(authz, perm)) {
    return NextResponse.json({ error: `missing permission: ${perm}` }, { status: 403 })
  }

  try {
    const outcome = await withOrgTransaction(authz.user.orgId, async () => {
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
    return paymentErrorResponse(e)
  }
}
