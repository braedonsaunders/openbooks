import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import {
  postPaymentWithApplications,
  type PaymentKind,
} from '@openbooks/engine/src/payments.ts'
import { submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/index.ts'
import { runPostDocumentEffects } from '@openbooks/engine/src/posting.ts'
import { can, getAuthz } from '../../../../lib/authz'
import { exactMoney, parseJsonBody, uuidId } from '../../../../lib/api/json'
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

  const r = (await db.execute<{ kind: PaymentKind; status: string }>(sql`
    select kind, status from documents
     where id = ${documentId} and kind in ('vendor_payment', 'customer_payment')
       and org_id = ${authz.user.orgId}
  `))
  if (!r.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
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
