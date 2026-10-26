import { z } from "zod";
import { apiErrorResponse } from "@/lib/api/error-response";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { withdrawReconciliationSignOff } from "@openbooks/engine/banking/banking";
import { isUuid } from "../../../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/**
 * Withdraw the newest sign-off on an account so its reopened period can be
 * corrected. The engine enforces newest-first order, Banking being open for
 * the period, and records the reason with the withdrawn evidence.
 */
export const POST = defineRoute({
  permission: "banking.reconcile",
  feature: "banking",
  body: z.object({ reason: z.string().trim().min(10).max(500) }).strict(),
  handler: async ({ authz, params: routeParams, body }) => {
    const { id } = routeParams as { id: string };
    if (!isUuid(id)) return notFound("record");
    try {
      const result = await withdrawReconciliationSignOff(id, body.reason, {
        orgId: authz.user.orgId,
        userId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
