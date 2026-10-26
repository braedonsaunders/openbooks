import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { listActiveSubscriptionPlans } from "@openbooks/engine/billing/quote-to-cash-read";

export const runtime = "nodejs";

/**
 * Active subscription plans for the quote term picker (id, name, catalog
 * price, currency, cadence). Read-only; pricing authority stays with the
 * engine valuation behind the terms endpoint.
 */
export const GET = defineRoute({
  permission: "ar.read",
  feature: "quoteToCash",
  handler: async ({ authz }) => {
    try {
      const plans = await listActiveSubscriptionPlans(authz.user.orgId);
      return NextResponse.json({ plans });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
