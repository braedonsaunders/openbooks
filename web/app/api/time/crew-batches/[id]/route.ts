import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { postDocument } from '@openbooks/engine/src/ledger/posting-document.ts'
import { paymentControlDeps } from '@openbooks/engine/src/payments/payment-accounts.ts'
import {
  approveBatchStage,
  postBatch,
  rejectBatch,
  setBatchLines,
  submitBatch,
  withdrawBatch,
} from '@openbooks/engine/src/hrm/field-time/crew.ts'
import { getBatchDetail } from '@openbooks/engine/src/hrm/field-time/reads.ts'
import { FieldTimeError } from '@openbooks/engine/src/hrm/field-time/errors.ts'

export const runtime = 'nodejs'

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status })
}

function fieldTime(error: unknown) {
  if (error instanceof FieldTimeError) return bad(error.message)
  throw error
}

async function batchGate(perm: 'time.crew.enter' | 'time.read' | 'time.approve' | 'time.manage') {
  return guardFeaturePermission(perm, 'fieldTimeCrewEntry')
}

/** GET → batch detail with lines and append-only history. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const read = await batchGate('time.read')
  const gate = read instanceof NextResponse ? await batchGate('time.crew.enter') : read
  if (gate instanceof NextResponse) return gate
  try {
    return NextResponse.json(await getBatchDetail(gate.user.orgId, id))
  } catch (error) {
    return fieldTime(error)
  }
}

const lineSchema = z.object({
  employeePartyId: z.string().min(1),
  hours: z.string().min(1),
  timeTypeId: z.string().nullable().optional(),
  projectTaskId: z.string().nullable().optional(),
  costCodeRef: z.string().max(80).nullable().optional(),
  equipmentId: z.string().nullable().optional(),
  equipmentHours: z.string().nullable().optional(),
  memo: z.string().max(2000).nullable().optional(),
})

const LINES_NEEDS = 'Lines need the worker and hours on every row'
const REJECT_NEEDS = 'Rejecting needs a reason — tell the foreman what to fix'

/**
 * The six batch actions as one body. The action names the branch and
 * the branch names what it needs, so an unknown action and a missing
 * reason are both refused here with the words the foreman reads.
 */
const batchActionBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('lines'), lines: z.array(lineSchema, { error: LINES_NEEDS }).max(500) }),
  z.object({ action: z.literal('submit'), signerName: z.string().nullish() }),
  z.object({ action: z.literal('withdraw'), reason: z.string().nullish() }),
  z.object({ action: z.literal('approve'), comment: z.string().nullish() }),
  z.object({ action: z.literal('reject'), reason: z.string({ error: REJECT_NEEDS }).trim().min(1, REJECT_NEEDS) }),
  z.object({ action: z.literal('post') }),
], { error: 'Unknown batch action — use lines, submit, withdraw, approve, reject or post' })

/**
 * POST {action} — lines (draft only), submit (signed), withdraw,
 * approve (current stage), reject (reason required), post (entries +
 * equipment charges, then the charge documents to the ledger).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const parsedBody = await parseJsonBody(req, batchActionBody, { status: 422 });
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  try {
    if (body.action === 'lines') {
      const gate = await batchGate('time.crew.enter')
      if (gate instanceof NextResponse) return gate
      await setBatchLines({ orgId: gate.user.orgId, actorUserId: gate.user.id, batchId: id, lines: body.lines })
      return NextResponse.json(await getBatchDetail(gate.user.orgId, id))
    }
    if (body.action === 'submit') {
      const gate = await batchGate('time.crew.enter')
      if (gate instanceof NextResponse) return gate
      await submitBatch({
        orgId: gate.user.orgId,
        actorUserId: gate.user.id,
        batchId: id,
        signerName: body.signerName ?? null,
      })
      return NextResponse.json(await getBatchDetail(gate.user.orgId, id))
    }
    if (body.action === 'withdraw') {
      const gate = await batchGate('time.crew.enter')
      if (gate instanceof NextResponse) return gate
      await withdrawBatch({
        orgId: gate.user.orgId,
        actorUserId: gate.user.id,
        batchId: id,
        reason: body.reason ?? null,
      })
      return NextResponse.json(await getBatchDetail(gate.user.orgId, id))
    }
    if (body.action === 'approve') {
      const gate = await batchGate('time.approve')
      if (gate instanceof NextResponse) return gate
      const status = await approveBatchStage({
        orgId: gate.user.orgId,
        actorUserId: gate.user.id,
        batchId: id,
        comment: body.comment ?? null,
      })
      return NextResponse.json({ status, batch: await getBatchDetail(gate.user.orgId, id) })
    }
    if (body.action === 'reject') {
      const gate = await batchGate('time.approve')
      if (gate instanceof NextResponse) return gate
      await rejectBatch({ orgId: gate.user.orgId, actorUserId: gate.user.id, batchId: id, reason: body.reason })
      return NextResponse.json(await getBatchDetail(gate.user.orgId, id))
    }
    if (body.action === 'post') {
      const gate = await batchGate('time.manage')
      if (gate instanceof NextResponse) return gate
      const result = await postBatch({ orgId: gate.user.orgId, actorUserId: gate.user.id, batchId: id })
      // The entries and charge documents committed in one transaction
      // above; each charge now posts to the ledger through the EXISTING
      // equipment charge path. A ledger failure names the charge
      // document so the approved charge can be re-posted, never lost.
      const entryIds: string[] = []
      for (const documentId of result.chargeDocumentIds) {
        try {
          entryIds.push(await postDocument(documentId, await paymentControlDeps(gate.user.orgId)))
        } catch (error) {
          return bad(
            `The batch posted but equipment charge ${documentId} did not reach the ledger (${error instanceof Error ? error.message : 'posting failed'}) — re-post the charge document from Equipment`,
          )
        }
      }
      return NextResponse.json({ ...result, ledgerEntryIds: entryIds })
    }
    // The union above admits exactly six actions, so this is
    // unreachable; it keeps the handler total for the type checker.
    return bad('Unknown batch action — use lines, submit, withdraw, approve, reject or post')
  } catch (error) {
    return fieldTime(error)
  }
}
