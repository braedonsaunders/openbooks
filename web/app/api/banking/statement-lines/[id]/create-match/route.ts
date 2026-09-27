import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { ControlAccountsIncompleteError } from '@openbooks/engine/src/records/control-accounts.ts'
import { PostingError } from "@openbooks/engine/src/journal/posting-contracts.ts";
import { isUuid } from '../../../../../../lib/list-params'
import { addJournalMatchFromLine, JournalPostingDeniedError } from '../../../../../../lib/banking-rules'
import { notFound } from "@/lib/api/responses";
const POSTBodySchema1 = z.object({ "reconciliationId": z.string().optional(), "offsetAccountId": z.string().optional() }).passthrough();



export const runtime = 'nodejs'

/** Add a journal from an unmatched bank line and match it: { reconciliationId, offsetAccountId }. */
export const POST = defineRoute({
  permission: 'banking.reconcile',
  feature: 'banking',
  body: POSTBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")

    const body = (routeBody) as { reconciliationId?: string; offsetAccountId?: string }
    if (!body.reconciliationId || !isUuid(body.reconciliationId) || !body.offsetAccountId || !isUuid(body.offsetAccountId)) {
        return NextResponse.json({ error: 'reconciliationId and offsetAccountId are required' }, { status: 400 })
      }
    try {
        await addJournalMatchFromLine(
          user.orgId,
          user.id,
          {
            statementLineId: id,
            offsetAccountId: body.offsetAccountId,
            reconciliationId: body.reconciliationId,
          },
          gate.allowedSubsidiaryIds,
        )
        return NextResponse.json({ ok: true })
      } catch (e) {
        if (e instanceof PostingError) return apiErrorResponse(e, { safeStatus: 422 })
        if (e instanceof JournalPostingDeniedError) return apiErrorResponse(e)
        // Unconfigured org control accounts refuse the match before any GL write.
        if (e instanceof ControlAccountsIncompleteError) {
          return apiErrorResponse(e, { safeStatus: 422 })
        }
        return apiErrorResponse(e)
      }
  },
});
