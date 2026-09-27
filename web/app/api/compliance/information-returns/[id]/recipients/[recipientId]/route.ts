import { defineRoute } from '@/lib/api/route'
import { z } from 'zod'
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json"
import { NextResponse } from 'next/server'
import {
  InformationReturnError,
  updateFilingRecipient,
} from '@openbooks/engine/src/compliance/information-returns.ts'
import { guardPermission, guardSubsidiaryScope } from '@/lib/authz'
import { guardComplianceFeature, loadInformationReturnFilingScope } from '@/lib/compliance'
import { complianceWriteFailure } from '@/lib/compliance-errors'
import { isUuid } from '@/lib/list-params'
import { canonicalDecimal } from '@/lib/exact-decimal'
import { moneyRefusal } from '@/lib/payroll-decimal-refusal'
import { notFound } from "@/lib/api/responses";

const adjustmentAmount = z.string().superRefine((value, context) => {
  if (canonicalDecimal(value, 4) === null) {
    context.addIssue({ code: 'custom', message: moneyRefusal('Recipient adjustment', value) })
  }
})
const requestBodySchema = z.object({
  adjustmentReason: z.string().trim().max(2000).nullable().optional(),
  adjustments: z.record(z.string(), adjustmentAmount).optional(),
  exclusionReason: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(['included', 'excluded']).optional(),
}).refine(
  (body) => body.status !== undefined || body.adjustments !== undefined || body.adjustmentReason !== undefined || body.exclusionReason !== undefined,
  { error: 'provide a status, adjustment, or reason to update the recipient' },
)



export const runtime = 'nodejs'

/**
 * Adjust or exclude one recipient of a filing.
 *
 * This route owns NO filing logic of its own. It used to read the filing
 * status outside any transaction and then update the recipient row with an
 * unguarded WHERE, so a finalize that committed between its read and its write
 * still mutated frozen evidence. Every mutation now goes through
 * `updateFilingRecipient` — the engine's one guarded path, which locks the
 * filing row and restates the freeze in the UPDATE itself — so an edit racing
 * a finalize either commits before the freeze or is refused after it, and can
 * never land on a frozen filing.
 */
export const PATCH = defineRoute({
  permission: 'compliance.manage',
  feature: { none: 'No optional feature applies to this permission-governed endpoint.' },
  params: z.object({ "id": z.string(), "recipientId": z.string() }),
  handler: async ({ request: req, authz: gate, params: routeParams }) => {
    const params = Promise.resolve(routeParams);
    const blocked = await guardComplianceFeature(gate.user.orgId)
    if (blocked) return blocked
    const { orgId, id: actorId } = gate.user
    const { id, recipientId } = await params
    if (!isUuid(id) || !isUuid(recipientId)) return notFound("record")
    // Entity isolation before the body is even parsed (same 404 as a missing filing).
    const filingScope = await loadInformationReturnFilingScope(orgId, id)
    if (!filingScope) return notFound("record")
    const scopeDenied = guardSubsidiaryScope(gate, filingScope.subsidiaryId)
    if (scopeDenied) return scopeDenied

    const parsedBody = await parseJsonBody(req, requestBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.data

    try {
      await updateFilingRecipient({
        orgId,
        filingId: id,
        recipientId,
        actorId,
        adjustments: body.adjustments,
        adjustmentReason: body.adjustmentReason ?? null,
        status: body.status,
        exclusionReason: body.exclusionReason ?? null,
      })
      return NextResponse.json({ id: recipientId })
    } catch (e) {
      if (e instanceof InformationReturnError) {
        return apiErrorResponse(e)
      }
      return complianceWriteFailure(e)
    }

  },
})
