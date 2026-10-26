import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AutopayError, enrollAutopay } from "@openbooks/engine/payments/autopay";
import { uuidId } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";
import { isUuid } from "@/lib/list-params";
import { db } from "@openbooks/engine/platform/database";
import { sql } from "drizzle-orm";
import { guardAutopayPartyScope } from "@/lib/autopay-scope";

export const runtime = "nodejs";

const enrollBody = z.object({
  partyId: uuidId,
  subscriptionId: uuidId.nullable().optional(),
  paymentMethodId: uuidId.nullable().optional(),
  chargeOnIssue: z.boolean().optional(),
});

/**
 * Autopay enrollment per customer or per subscription. POST enrolls (the
 * method defaults to the customer's default); PATCH moves the lifecycle.
 */
export const GET = defineRoute({
  permission: "payment_methods.read",
  feature: "autopay",
  handler: async ({ authz, request }) => {
    const partyId = new URL(request.url).searchParams.get("partyId") ?? "";
    if (!partyId || !isUuid(partyId))
      return NextResponse.json({ error: "partyId is required" }, { status: 400 });
    const outOfScope = await guardAutopayPartyScope(authz, partyId);
    if (outOfScope) return outOfScope;
    // Plans carry their display name; subscriptions link to them by plan id.
    const rows = await db.execute(
      sql`
      select e.id, e.party_id as "partyId", e.subscription_id as "subscriptionId",
             e.payment_method_id as "paymentMethodId", e.status,
             e.charge_on_issue as "chargeOnIssue", sp.name as "subscriptionName"
        from autopay_enrollments e
        left join subscriptions s on s.id = e.subscription_id and s.org_id = e.org_id
        left join subscription_plans sp on sp.id = s.plan_id and sp.org_id = s.org_id
       where e.org_id = ${authz.user.orgId} and e.party_id = ${partyId} and e.status <> 'canceled'
       order by e.created_at desc
    `,
      "objects",
    );
    return NextResponse.json({ enrollments: rows });
  },
});

export const POST = defineRoute({
  permission: "autopay.manage",
  feature: "autopay",
  body: enrollBody,
  handler: async ({ authz, body }) => {
    const outOfScope = await guardAutopayPartyScope(authz, body.partyId);
    if (outOfScope) return outOfScope;
    try {
      const enrollment = await enrollAutopay(authz.user.orgId, {
        partyId: body.partyId,
        subscriptionId: body.subscriptionId ?? null,
        paymentMethodId: body.paymentMethodId ?? null,
        chargeOnIssue: body.chargeOnIssue ?? false,
        actorId: authz.user.id,
      });
      return NextResponse.json({ enrollment });
    } catch (e) {
      if (e instanceof AutopayError) return apiErrorResponse(e, { safeStatus: 422 });
      throw e;
    }
  },
});
