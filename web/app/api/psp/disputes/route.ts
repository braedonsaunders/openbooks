import { uuidString } from "@openbooks/engine/platform/identifiers";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/database";
import {
  PspAutomationError,
  approveDisputeReview,
} from "@openbooks/engine/payments/refund-automation";
import { can } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";

const reviewBody = z.strictObject({
  action: z.literal("submit"),
  disputeId: uuidString(),
});

export const runtime = "nodejs";

/** Submit the exact parked provider event to tenant Flows before native posting. */
export const POST = defineRoute({
  public: "session",
  body: reviewBody,
  handler: async ({ authz, body }) => {
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!(await isFeatureEnabled(authz.user.orgId, "banking"))) {
      return notFound("record");
    }
    if (!can(authz, "banking.reconcile")) {
      return NextResponse.json({ error: "missing permission: banking.reconcile" }, { status: 403 });
    }
    if (!isUuid(body.disputeId)) return notFound("record");
    const orgId = authz.user.orgId;
    // Dispute rows are never deleted — only transitioned — so an existence
    // read stays true through the engine call below. A queued review from
    // another tenant reads as 404, never as a foreign refusal.
    const existing = await db.execute<{ id: string }>(
      sql`
      select id from payment_disputes
       where org_id = ${orgId} and id = ${body.disputeId}
       limit 1
    `,
      "objects",
    );
    if (!existing[0]) return notFound("record");
    try {
      const outcome = await approveDisputeReview(
        orgId,
        body.disputeId,
        authz.user.id,
        authz.allowedSubsidiaryIds,
      );
      return NextResponse.json(outcome, {
        status: outcome.status === "pending_review" ? 202 : 200,
      });
    } catch (e) {
      if (e instanceof PspAutomationError) {
        return apiErrorResponse(e, { safeStatus: 422 });
      }
      return apiErrorResponse(e);
    }
  },
});
