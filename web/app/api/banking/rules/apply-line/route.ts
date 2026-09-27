import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { PostingError } from "@openbooks/engine/src/journal/posting-contracts.ts";
import { isUuid } from '../../../../../lib/list-params'
import { applyRuleToLine, JournalPostingDeniedError } from '../../../../../lib/banking-rules'
const POSTBodySchema1 = z.object({ "statementLineId": z.string().optional(), "ruleId": z.string().optional(), "reconciliationId": z.string().optional() }).passthrough();


export const runtime = 'nodejs'

/** Apply one rule to one unmatched line — confirming a suggested categorization. */
export const POST = defineRoute({
  permission: 'banking.reconcile',
  feature: 'banking',
  body: POSTBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, body: routeBody }) => {
    const gate = routeAuthz;
    const { user } = gate

    const body = (routeBody) as {
        statementLineId?: string
        ruleId?: string
        reconciliationId?: string
      }
    if (!body.statementLineId || !isUuid(body.statementLineId)) {
        return NextResponse.json({ error: 'statementLineId is required' }, { status: 400 })
      }
    if (!body.ruleId || !isUuid(body.ruleId)) {
        return NextResponse.json({ error: 'ruleId is required' }, { status: 400 })
      }
    try {
        await applyRuleToLine(
          user.orgId,
          user.id,
          {
            statementLineId: body.statementLineId,
            ruleId: body.ruleId,
            reconciliationId: body.reconciliationId && isUuid(body.reconciliationId) ? body.reconciliationId : undefined,
          },
          gate.allowedSubsidiaryIds,
        )
        return NextResponse.json({ ok: true })
      } catch (e) {
        if (e instanceof PostingError) return apiErrorResponse(e, { safeStatus: 422 })
        if (e instanceof JournalPostingDeniedError) return apiErrorResponse(e)
        return apiErrorResponse(e)
      }
  },
});
