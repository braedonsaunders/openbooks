import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { PostingError } from "@openbooks/engine/src/journal/posting-contracts.ts";
import { isUuid } from '../../../../../lib/list-params'
import { applyRulesToAccount, JournalPostingDeniedError } from '../../../../../lib/banking-rules'
const POSTBodySchema1 = z.object({ "accountId": z.string().optional() }).passthrough();


export const runtime = 'nodejs'

/** Run active reconciliation rules against an account's unmatched bank lines. */
export const POST = defineRoute({
  permission: 'banking.reconcile',
  feature: 'banking',
  body: POSTBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, body: routeBody }) => {
    const gate = routeAuthz;
    const { user } = gate

    const body = (routeBody) as { accountId?: string }
    if (!body.accountId || !isUuid(body.accountId)) {
        return NextResponse.json({ error: 'accountId is required' }, { status: 400 })
      }
    try {
        const result = await applyRulesToAccount(
          user.orgId,
          user.id,
          body.accountId,
          gate.allowedSubsidiaryIds,
        )
        return NextResponse.json(result)
      } catch (e) {
        if (e instanceof PostingError) return apiErrorResponse(e, { safeStatus: 422 })
        if (e instanceof JournalPostingDeniedError) return apiErrorResponse(e)
        return apiErrorResponse(e)
      }
  },
});
