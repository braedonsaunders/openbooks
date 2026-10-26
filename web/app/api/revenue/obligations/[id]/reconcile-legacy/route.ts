import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  reconcileLegacyObligation,
  RevenueRecognitionError,
} from "@openbooks/engine/revenue/recognition";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { defineRoute } from "@/lib/api/route";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const reconcileBody = z.object({
  reason: z.string().trim().min(5).max(500),
});

/**
 * Reconcile one legacy-provenance obligation: the operator attests
 * that the obligation's existing schedule matches the policy actually in
 * force at its creation, lifting the rebuild refusal for that obligation
 * only. Refuses when there is nothing to reconcile (rule not legacy, no
 * schedule evidence, or already reconciled).
 */
export const POST = defineRoute({
  permission: "ar.post",
  feature: "revenueRecognition",
  params: z.object({ id: z.string() }),
  body: reconcileBody,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, params, body }) => {
    const { id } = params;
    if (!isUuid(id)) return NextResponse.json({ error: "invalid obligation" }, { status: 422 });
    try {
      await reconcileLegacyObligation({
        orgId: gate.user.orgId,
        obligationId: id,
        actorId: gate.user.id,
        reason: body.reason,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      if (e instanceof ScopeNotFoundError) {
        return notFound("record");
      }
      if (e instanceof RevenueRecognitionError) {
        return apiErrorResponse(e, { safeStatus: 422 });
      }
      console.error("[revenue/reconcile-legacy] reconciliation failed", e);
      return NextResponse.json({ error: "reconciliation failed" }, { status: 500 });
    }
  },
});
