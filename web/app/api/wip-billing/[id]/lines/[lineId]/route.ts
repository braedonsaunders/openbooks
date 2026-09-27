import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { canonicalDecimal } from '../../../../../../lib/exact-decimal'
import { moneyRefusal } from '../../../../../../lib/payroll-decimal-refusal'
import { isUuid } from '../../../../../../lib/list-params'
import { holdPrebillLine, updatePrebillLine } from '../../../../../../lib/wip-billing'
import { isDocumentRevisionToken } from '@openbooks/engine/src/records/revision.ts'
import { notFound } from "@/lib/api/responses";
const PATCHBodySchema1 = z.discriminatedUnion('action', [
  z.object({ action: z.literal('hold'), reason: z.string().trim().min(1), evidence: z.array(z.string()).optional() }),
  z.object({ action: z.literal('update').default('update'), proposedBillAmount: z.string(), expectedUpdatedAt: z.string().min(1), adjustmentReason: z.string().nullable().optional(), adjustmentEvidence: z.array(z.string()).optional() }),
]);



export const runtime = 'nodejs'

/** Exact numeric(19,4) money string, or null when the request value is not canonical. */
function exactMoney(value: unknown): string | null {
  const exact = canonicalDecimal(value, 4)
  if (exact === null) return null
  try {
    return normalizeMoney(exact)
  } catch {
    return null
  }
}

export const PATCH = defineRoute({
  permission: 'projects.manage',
  feature: 'wipBilling',
  body: PATCHBodySchema1,
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string; lineId: string });
    const gate = routeAuthz;
    const { id, lineId } = await params
    if (!isUuid(id) || !isUuid(lineId)) return notFound("record")

    const body = (routeBody) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'body required' }, { status: 400 })
    try {
        if (body.action === 'hold') {
          const result = await holdPrebillLine(
            gate.user.orgId,
            gate.user.id,
            id,
            lineId,
            String(body.reason ?? ''),
            Array.isArray(body.evidence) ? body.evidence.map(String) : [],
            gate.allowedSubsidiaryIds,
          )
          return NextResponse.json(result)
        }
        const proposedBillAmount = exactMoney(body.proposedBillAmount)
        if (proposedBillAmount === null) {
          return NextResponse.json({ error: moneyRefusal('Proposed bill amount', body.proposedBillAmount) }, { status: 422 })
        }
        // Mandatory optimistic-concurrency evidence (same contract as document and
        // payment edits): a stale tab must 409 instead of overwriting a newer
        // adjustment. Checked after the gates so a missing token never leaks
        // line existence to an unauthorized caller.
        if (!isDocumentRevisionToken(body.expectedUpdatedAt)) {
          return NextResponse.json({ error: 'A current line revision is required; reload the worksheet and try again' }, { status: 409 })
        }
        const result = await updatePrebillLine(gate.user.orgId, gate.user.id, id, lineId, {
          proposedBillAmount,
          adjustmentReason: body.adjustmentReason == null ? null : String(body.adjustmentReason),
          adjustmentEvidence: Array.isArray(body.adjustmentEvidence) ? body.adjustmentEvidence.map(String) : [],
        }, gate.allowedSubsidiaryIds, { expectedRevision: body.expectedUpdatedAt })
        return NextResponse.json(result)
      } catch (error) {
        return apiErrorResponse(error)
      }
  },
});
