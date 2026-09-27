import { apiErrorResponse } from '@/lib/api/error-response'
import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { excludePossibleDuplicates } from '@openbooks/engine/src/banking/banking.ts'
import { isUuid } from '../../../../../lib/list-params'
const POSTBodySchema1 = z.object({ "action": z.string().optional(), "accountId": z.string().optional(), "reason": z.string().optional() }).passthrough();


export const runtime = 'nodejs'

/**
 * Bulk review of flagged lines: { action: 'exclude-duplicates', accountId, reason }.
 * Excludes every flagged unmatched line on the account as duplicates of
 * their earlier imports — the reviewer's answer to a re-exported file, so
 * it is not one click per line. One audited row per line.
 */
export const POST = defineRoute({
  permission: 'banking.reconcile',
  feature: 'banking',
  body: POSTBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, body: routeBody }) => {
    const gate = routeAuthz;
    const { user } = gate

    const body = (routeBody) as { action?: string; accountId?: string; reason?: string }
    if (body.action !== 'exclude-duplicates' || !isUuid(String(body.accountId ?? ''))) {
        return NextResponse.json({ error: 'action must be "exclude-duplicates" with an accountId' }, { status: 400 })
      }
    try {
        const result = await excludePossibleDuplicates(
          String(body.accountId),
          String(body.reason ?? ''),
          { orgId: user.orgId, userId: user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
        )
        return NextResponse.json({ ok: true, excluded: result.excluded })
      } catch (e) {
        return apiErrorResponse(e)
      }
  },
});
