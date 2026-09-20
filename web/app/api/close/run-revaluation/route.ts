import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { RevaluationError, RevaluationFeatureDisabledError, runRevaluation } from '@openbooks/engine/src/close/fx-revaluation.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

interface Body {
  periodId?: string
  /** Defaults to the primary book; pass a secondary (e.g. tax) book to revalue it. */
  bookId?: string
}

/**
 * Run period-end unrealized FX revaluation for an accounting period: restate
 * foreign-currency monetary balances (bank / AR / AP) to the period-end spot
 * rate, booking the remaining unrealized gain/loss (origin='fx_revaluation')
 * and its next-period mirror. Changed balances or rates receive incremental
 * corrections; unchanged reruns post nothing. Requires
 * orgs.settings.controlAccounts.fxUnrealizedGainLoss.
 * The multiCurrency feature must also be on — a disabled FX module cannot
 * still post unrealized gain/loss through this close action.
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('close.run', 'multiCurrency')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Body
  if (!body.periodId || !isUuid(body.periodId)) {
    return NextResponse.json({ error: 'invalid period' }, { status: 422 })
  }
  if (body.bookId !== undefined && !isUuid(body.bookId)) {
    return NextResponse.json({ error: 'invalid book' }, { status: 422 })
  }

  try {
    const result = await runRevaluation(
      user.orgId,
      body.periodId,
      user.id,
      gate.allowedSubsidiaryIds ? [...gate.allowedSubsidiaryIds] : undefined,
      body.bookId,
    )
    return NextResponse.json(result)
  } catch (e: unknown) {
    if (e instanceof RevaluationFeatureDisabledError) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    // Every RevaluationError throw site is request state, not a server
    // defect: unconfigured book/control account, an unknown or closed
    // period, a missing spot rate, an inactive subsidiary, an unbalanced
    // entry. Fail those closed with 422; only systemic throws stay 500.
    if (e instanceof RevaluationError) {
      return NextResponse.json({ error: e.message }, { status: 422 })
    }
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
