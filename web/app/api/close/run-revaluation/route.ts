import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'

import { NextResponse } from 'next/server'
import { RevaluationError, RevaluationFeatureDisabledError, runRevaluation } from '@openbooks/engine/src/close/fx-revaluation.ts'

import { isUuid } from '../../../../lib/list-params'
import { notFound } from "@/lib/api/responses";

const requestBodySchema = z.object({ periodId: z.string().uuid(), bookId: z.string().uuid().optional() });



export const runtime = 'nodejs'

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


export const POST = defineRoute({
  permission: "close.run",
  feature: "multiCurrency",
  body: requestBodySchema,
  handler: async ({ body, authz: routeAuthz }) => {

    const gate = routeAuthz

    const user = gate.user




    if (!body.periodId || !isUuid(body.periodId)) {
      return NextResponse.json({ error: 'invalid period' }, { status: 422 })
    }
    if (body.bookId !== undefined && !isUuid(body.bookId)) {
      return NextResponse.json({ error: 'invalid book' }, { status: 422 })
    }

    // A restricted caller whose visibility resolves to an empty subsidiary set
    // must fail closed like the sibling close runs and posting-periods routes:
    // spreading the empty set into [] loops zero subsidiaries and reports 200
    // {posted:[],skipped:[],problems:[]} with no observable work. Null is the
    // explicit unrestricted sentinel and passes through untouched.
    if (gate.allowedSubsidiaryIds !== null && gate.allowedSubsidiaryIds.size === 0) {
      return NextResponse.json(
        { error: "no subsidiaries are in the caller's close scope — ask an administrator with unrestricted subsidiary visibility to run this close action" },
        { status: 403 },
      )
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
        return notFound("record")
      }
      // Every RevaluationError throw site is request state, not a server
      // defect: unconfigured book/control account, an unknown or closed
      // period, a missing spot rate, an inactive subsidiary, an unbalanced
      // entry. Fail those closed with 422; only systemic throws stay 500.
      if (e instanceof RevaluationError) {
        return apiErrorResponse(e, { safeStatus: 422 })
      }
      return apiErrorResponse(e)
    }
  },
});
