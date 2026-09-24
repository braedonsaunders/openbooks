import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  cancelRevenueRecognitionForInvoice,
  RevenueRecognitionCancellationError,
} from '@openbooks/engine/src/revenue/recognition.ts'
import { ScopeNotFoundError } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { DocumentVoidError } from '@openbooks/engine/src/ledger/document-void.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { sql } from 'drizzle-orm'
import { guardPermission, guardSubsidiaryScope } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { isoDate, parseJsonBody, uuidId } from '../../../../lib/api/json'
import { isDocKindEnabled } from "../../../../lib/documents.ts";

export const runtime = 'nodejs'

const cancelRecognitionBody = z.object({
  documentId: z
    .string({ error: 'invalid invoice' })
    .refine((v) => uuidId.safeParse(v).success, 'invalid invoice'),
  reason: z.string().trim().min(5).max(500),
  reversalDate: isoDate().optional(),
})

export type CancelRecognitionRequest = z.input<typeof cancelRecognitionBody>

/**
 * Cancel revenue recognition for one invoice: reverse every posted
 * recognition journal with an exact compensating entry, mark the obligations
 * cancelled, then route the invoice through the normal controlled void. This
 * is the dedicated cancellation workflow the invoice-void refusal points at —
 * voiding a revenue-recognition invoice directly stays refused.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('ar.post')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  if (!(await isFeatureEnabled(user.orgId, 'revenueRecognition'))) {
    return NextResponse.json({ error: 'feature disabled' }, { status: 404 })
  }

  const parsed = await parseJsonBody(req, cancelRecognitionBody, { status: 422 })
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  const found = (await db.execute<{ kind: string; subsidiaryId: string | null }>(sql`
    select kind, subsidiary_id as "subsidiaryId"
      from documents
     where id = ${body.documentId} and org_id = ${user.orgId}
  `))
  const doc = found.rows[0]
  if (!doc) return NextResponse.json({ error: 'invoice not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, doc.subsidiaryId)
  if (denied) return denied
  if (!(await isDocKindEnabled(user.orgId, doc.kind))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const reversalDate = body.reversalDate ?? (await businessToday(user.orgId))

  try {
    const result = await cancelRevenueRecognitionForInvoice({
      documentId: body.documentId,
      orgId: user.orgId,
      actorId: user.id,
      reason: body.reason,
      reversalDate,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    })
    return NextResponse.json(
      { ok: true, ...result },
      { status: result.status === 'pending_approval' ? 202 : 200 },
    )
  } catch (error) {
    if (error instanceof ScopeNotFoundError) {
      return NextResponse.json({ error: 'invoice not found' }, { status: 404 })
    }
    if (error instanceof RevenueRecognitionCancellationError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    if (error instanceof DocumentVoidError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    throw error
  }
}
