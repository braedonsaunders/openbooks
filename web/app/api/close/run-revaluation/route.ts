import { NextResponse } from 'next/server'
import { runRevaluation } from '@openbooks/engine/src/fx-revaluation.ts'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

interface Body {
  periodId?: string
}

/**
 * Run period-end unrealized FX revaluation for an accounting period: restate
 * foreign-currency monetary balances (bank / AR / AP) to the period-end spot
 * rate, booking the unrealized gain/loss (origin='revaluation') and a mirror
 * reversal on the first day of the next period. Idempotent — an already-revalued
 * subsidiary is skipped. Requires orgs.settings.controlAccounts.fxUnrealizedGainLoss.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('close.run')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const body = (await req.json().catch(() => ({}))) as Body
  if (!body.periodId || !isUuid(body.periodId)) {
    return NextResponse.json({ error: 'invalid period' }, { status: 422 })
  }

  try {
    const result = await runRevaluation(
      user.orgId,
      body.periodId,
      user.id,
      gate.allowedSubsidiaryIds ? [...gate.allowedSubsidiaryIds] : undefined,
    )
    return NextResponse.json(result)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
