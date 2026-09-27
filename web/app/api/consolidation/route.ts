import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { guardSubsidiaryScope } from '@/lib/authz'
import { NextResponse } from 'next/server'
import {
  ConsolidationError,
  deriveConsolidatedRates,
  runAutoElimination,
  runCombinedConsolidation,
  runOwnershipConsolidation,
} from '@openbooks/engine/src/consolidation/consolidation.ts'
import { withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { isUuid } from '../../../lib/list-params'
const POSTBodySchema1 = z.object({ "action": z.string().optional(), "periodId": z.string().optional() }).passthrough();


export const runtime = 'nodejs'

/**
 * Consolidation actions, run from the Period Close page (multi-subsidiary orgs
 * only): derive the period's consolidated exchange rates from daily fx_rates,
 * or (re-)post the period's auto-elimination entry into the elimination
 * subsidiary. Both are idempotent per period, and the combined 'consolidate'
 * action commits derivation + ownership + elimination as one atomic unit.
 * Gated by close.run — these are
 * period-close controller actions, and by the multiSubsidiary feature so a
 * disabled consolidation module cannot be driven through this API.
 */
export const POST = defineRoute({
  permission: 'close.run',
  feature: 'multiSubsidiary',
  body: POSTBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, body: routeBody }) => {
    const gate = routeAuthz;
    const scopeDenied = guardSubsidiaryScope(gate, null)
    if (scopeDenied) return scopeDenied
    const user = gate.user

    const { action, periodId } = (routeBody) as {
        action?: string
        periodId?: string
      }
    if (!periodId || !isUuid(periodId) || !['derive-rates', 'ownership', 'eliminate', 'consolidate'].includes(action ?? '')) {
        return NextResponse.json(
          { error: 'periodId and action (derive-rates|ownership|eliminate|consolidate) required' },
          { status: 400 },
        )
      }
    try {
        if (action === 'derive-rates') {
          // Derivation writes one row per currency pair; run it as ONE atomic unit
          // so a missing spot rate for any needed pair aborts the whole refresh
          // instead of leaving earlier pairs' derived rows committed over a stale
          // remainder (a partially refreshed period). The engine refuses a period
          // whose GL is closed (422) and audits every changed rate to this actor.
          const written = await withOrgTransaction(user.orgId, () =>
            deriveConsolidatedRates(user.orgId, periodId, user.id),
          )
          return NextResponse.json({ ok: true, written })
        }
        if (action === 'ownership') {
          const result = await runOwnershipConsolidation(user.orgId, periodId, user.id)
          return NextResponse.json({ ok: true, ...result })
        }
        if (action === 'consolidate') {
          // One atomic unit: rates, ownership, and elimination commit together or
          // not at all. A residual elimination failure must not leave derived
          // rates and POSTED ownership journals durable while the client is told
          // the command failed.
          const { ratesWritten, ownership, elimination } = await runCombinedConsolidation(user.orgId, periodId, user.id)
          return NextResponse.json({ ok: true, ratesWritten, ownership, elimination })
        }
        const result = await runAutoElimination(user.orgId, periodId, user.id)
        return NextResponse.json({ ok: true, ...result })
      } catch (e) {
        if (e instanceof ConsolidationError) {
          // Typed refusal: the close task persists the message
          // inline and maps the code, instead of swallowing a bare 422.
          return apiErrorResponse(e, { safeStatus: 422, details: { code: e.code } })
        }
        throw e
      }
  },
});
