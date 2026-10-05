import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "@openbooks/engine/platform/database";

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
      const plans = await withOrgContext(authz.user.orgId, () =>
        db.execute<{
          id: string;
          name: string;
          amount: string;
          currency: string | null;
          interval: string;
          interval_count: number;
        }>(sql`
          select id, name, amount::text as amount, currency_code as currency,
                 interval, interval_count
            from subscription_plans
           where org_id = ${authz.user.orgId} and is_active
           order by name`),
      );
      return NextResponse.json({ plans: plans.rows });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
