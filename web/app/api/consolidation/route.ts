import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import {
  ConsolidationError,
  deriveConsolidatedRates,
  runAutoElimination,
  runCombinedConsolidation,
  runOwnershipConsolidation,
} from '@openbooks/engine/src/consolidation.ts'
import { withOrgTransaction } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../lib/feature-gates'
import { isUuid } from '../../../lib/list-params'

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
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('close.run', 'multiSubsidiary')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const { action, periodId } = (parsedBody.data) as {
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
      // remainder (a partially refreshed period).
      const written = await withOrgTransaction(user.orgId, () =>
        deriveConsolidatedRates(user.orgId, periodId),
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
    const { entryId, lineCount } = await runAutoElimination(user.orgId, periodId, user.id)
    return NextResponse.json({ ok: true, entryId, lineCount })
  } catch (e) {
    if (e instanceof ConsolidationError) {
      return NextResponse.json({ error: e.message }, { status: 422 })
    }
    throw e
  }
}
