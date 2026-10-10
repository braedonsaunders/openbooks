import { apiErrorResponse } from '@/lib/api/error-response'
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { subsidiaryScopeAllows } from '../../../../../lib/authz'
import { listReconcilableBankAccounts } from '../../../../../lib/banking-accounts'

export const runtime = 'nodejs'

/**
 * Reconcilable bank/card accounts visible to the caller, for the statement
 * import dialog's required account picker: id, display label, currency and
 * type so the dialog defaults from the page, shows the choice visibly, and
 * warns on currency mismatch before the engine refuses.
 */
export const GET = defineRoute({
  permission: 'banking.read',
  feature: 'banking',
  handler: async ({ request: _req, authz: routeAuthz }) => {
    const gate = routeAuthz;
    const { user } = gate
    try {
        const accounts = await listReconcilableBankAccounts(user.orgId)
        return NextResponse.json({
          ok: true,
          accounts: accounts
            .filter((a) => subsidiaryScopeAllows(gate.allowedSubsidiaryIds, a.subsidiaryId))
            .map((a) => ({
              id: a.id,
              label: [a.number, a.name].filter(Boolean).join(' · '),
              currency: a.currency,
              type: a.type,
            })),
        })
      } catch (e) {
        return apiErrorResponse(e)
      }
  },
});
