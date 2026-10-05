import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  PspAutomationError,
  approveDisputeReview,
  rejectDisputeReview,
} from "@openbooks/engine/src/payments/psp-refund-automation.ts";
import { can } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";

const reviewBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("approve"), disputeId: z.string() }),
  z.strictObject({
    action: z.literal("reject"),
    disputeId: z.string(),
    reason: z.string().trim().min(1).max(500),
  }),
]);

export const runtime = "nodejs";

/**
 * Operator review of parked provider refunds and disputes. Approving resumes
 * the automatic posting path (the approval is the policy gate); rejecting
 * moves nothing and waits for the provider's next event. Both mutate posted
 * or soon-posted money, so they carry banking.reconcile like settlement
 * posting — a reader with banking.read sees the queue but cannot resolve it.
 */
export const POST = defineRoute({
  public: "session",
  body: reviewBody,
  handler: async ({ authz, body }) => {
    if (!authz)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!(await isFeatureEnabled(authz.user.orgId, "banking"))) {
      return notFound("record");
    }
    if (!can(authz, "banking.reconcile")) {
      return NextResponse.json(
        { error: "missing permission: banking.reconcile" },
        { status: 403 },
      );
    }
    if (!isUuid(body.disputeId)) return notFound("record");
    const orgId = authz.user.orgId;
    // Dispute rows are never deleted — only transitioned — so an existence
    // read stays true through the engine call below. A queued review from
    // another tenant reads as 404, never as a foreign refusal.
    const existing = await db.execute<{ id: string }>(sql`
      select id from payment_disputes
       where org_id = ${orgId} and id = ${body.disputeId}
       limit 1
    `);
    if (!existing.rows[0]) return notFound("record");
    try {
      if (body.action === "approve") {
        const outcome = await approveDisputeReview(
          orgId,
          body.disputeId,
          authz.user.id,
        );
        return NextResponse.json(outcome);
      }
      await rejectDisputeReview(
        orgId,
        body.disputeId,
        authz.user.id,
        body.reason,
      );
      return NextResponse.json({ ok: true });
    } catch (e) {
      if (e instanceof PspAutomationError) {
        return apiErrorResponse(e, { safeStatus: 422 });
      }
      return apiErrorResponse(e);
    }
  },
});
