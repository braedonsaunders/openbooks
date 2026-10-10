import { apiErrorResponse } from '@/lib/api/error-response'
import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { clearPossibleDuplicateFlag, correctStatementLine, excludeStatementLine, restoreStatementLine } from '@openbooks/engine/src/banking/banking.ts'
import { isUuid } from '../../../../../lib/list-params'
import { notFound } from "@/lib/api/responses";
const PATCHBodySchema1 = z.discriminatedUnion('action', [
  z.object({ action: z.literal('exclude'), reason: z.string().trim().min(1) }),
  z.object({ action: z.literal('restore') }), z.object({ action: z.literal('clear-duplicate') }),
  z.object({
    action: z.literal('correct'),
    amount: z.string().trim().min(1).optional(),
    postedOn: z.string().trim().min(1).optional(),
    description: z.string().max(10000).optional().nullable(),
  }).refine((body) => body.amount !== undefined || body.postedOn !== undefined || body.description !== undefined, {
    message: 'correct needs at least one of amount, postedOn or description',
  }),
]);



export const runtime = 'nodejs'

/** Toggle a statement line's exclusion, clear its possible-duplicate flag, or correct an unmatched line. */
export const PATCH = defineRoute({
  permission: 'banking.reconcile',
  feature: 'banking',
  body: PATCHBodySchema1,
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")

    const body = (routeBody) as { action?: string; reason?: string; amount?: string; postedOn?: string; description?: string | null }
    try {
        if (body.action === 'exclude') {
          await excludeStatementLine(id, String(body.reason ?? ''), {
            orgId: user.orgId,
            userId: user.id,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
          })
        }
        else if (body.action === 'restore')
          await restoreStatementLine(id, {
            orgId: user.orgId,
            userId: user.id,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
          })
        else if (body.action === 'clear-duplicate')
          await clearPossibleDuplicateFlag(id, {
            orgId: user.orgId,
            userId: user.id,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
          })
        else if (body.action === 'correct')
          await correctStatementLine(id, {
            ...(body.amount !== undefined ? { amount: body.amount } : {}),
            ...(body.postedOn !== undefined ? { postedOn: body.postedOn } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
          }, {
            orgId: user.orgId,
            userId: user.id,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
          })
        else return NextResponse.json({ error: 'action must be "exclude", "restore", "clear-duplicate" or "correct"' }, { status: 400 })
        return NextResponse.json({ ok: true })
      } catch (e) {
        return apiErrorResponse(e)
      }
  },
});
