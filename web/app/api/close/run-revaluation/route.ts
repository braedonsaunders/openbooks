import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";

import { NextResponse } from "next/server";
import {
  RevaluationError,
  RevaluationFeatureDisabledError,
  RevaluationScopeError,
  revaluationSubsidiarySelection,
  runRevaluation,
} from "@openbooks/engine/close/fx-revaluation";

import { isUuid } from "../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";

const requestBodySchema = z.object({
  periodId: uuidString(),
  bookId: uuidString().optional(),
  subsidiaryIds: z
    .array(uuidString().transform((id) => id.toLowerCase()))
    .min(1)
    .max(1000)
    .optional(),
});

export const runtime = "nodejs";

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
    const gate = routeAuthz;

    const user = gate.user;

    if (!body.periodId || !isUuid(body.periodId)) {
      return NextResponse.json({ error: "invalid period" }, { status: 422 });
    }
    if (body.bookId !== undefined && !isUuid(body.bookId)) {
      return NextResponse.json({ error: "invalid book" }, { status: 422 });
    }

    try {
      const result = await runRevaluation(
        user.orgId,
        body.periodId,
        user.id,
        revaluationSubsidiarySelection(gate.allowedSubsidiaryIds, body.subsidiaryIds),
        body.bookId,
      );
      return NextResponse.json(result);
    } catch (e: unknown) {
      if (e instanceof RevaluationScopeError) return apiErrorResponse(e, { safeStatus: e.status });
      if (e instanceof RevaluationFeatureDisabledError) {
        return notFound("record");
      }
      // Every RevaluationError throw site is request state, not a server
      // defect: unconfigured book/control account, an unknown or closed
      // period, a missing spot rate, an inactive subsidiary, an unbalanced
      // entry. Fail those closed with 422; only systemic throws stay 500.
      if (e instanceof RevaluationError) {
        return apiErrorResponse(e, { safeStatus: 422 });
      }
      return apiErrorResponse(e);
    }
  },
});
