import { apiErrorResponse } from '@/lib/api/error-response'
import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { isUuid } from '../../../../../lib/list-params'
import { ensureOpenReconciliation } from '../../../../../lib/banking-rules'
const POSTBodySchema1 = z.object({ accountId: z.string().uuid() });


export const runtime = 'nodejs'

/** Find-or-create the open reconciliation for an account (Match Bank Data entry). */
export const POST = defineRoute({
  permission: 'banking.reconcile',
  feature: 'banking',
  body: POSTBodySchema1,
  handler: async ({ request: _req, authz: routeAuthz, body: routeBody }) => {
    const gate = routeAuthz;
    const { user } = gate

    const body = (routeBody) as { accountId?: string }
    if (!body.accountId || !isUuid(body.accountId)) {
        return NextResponse.json({ error: 'accountId is required' }, { status: 400 })
      }
    try {
        const id = await ensureOpenReconciliation(
          user.orgId,
          user.id,
          body.accountId,
          gate.allowedSubsidiaryIds,
        )
        return NextResponse.json({ id })
      } catch (e) {
        return apiErrorResponse(e)
      }
  },
});
