import { NextResponse } from 'next/server'
import {
  ConsolidationError,
  deriveConsolidatedRates,
  runAutoElimination,
} from '@openbooks/engine/src/consolidation.ts'
import { guardPermission } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'

export const runtime = 'nodejs'

/**
 * Consolidation actions, run from the Period Close page (multi-subsidiary orgs
 * only): derive the period's consolidated exchange rates from daily fx_rates,
 * or (re-)post the period's auto-elimination entry into the elimination
 * subsidiary. Both are idempotent per period. Gated by close.run — these are
 * period-close controller actions.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('close.run')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const { action, periodId } = (await req.json().catch(() => ({}))) as {
    action?: string
    periodId?: string
  }
  if (!periodId || !isUuid(periodId) || !['derive-rates', 'eliminate'].includes(action ?? '')) {
    return NextResponse.json(
      { error: 'periodId and action (derive-rates|eliminate) required' },
      { status: 400 },
    )
  }

  try {
    if (action === 'derive-rates') {
      const written = await deriveConsolidatedRates(user.orgId, periodId)
      return NextResponse.json({ ok: true, written })
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
