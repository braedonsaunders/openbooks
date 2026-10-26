import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";

export interface ActiveSubscriptionPlan {
  id: string;
  name: string;
  amount: string;
  currency: string | null;
  interval: string;
  interval_count: number;
}

/** List active subscription plans for quote term selection. */
export async function listActiveSubscriptionPlans(
  orgId: string,
): Promise<ActiveSubscriptionPlan[]> {
  return withOrgContext(orgId, () =>
    db.execute<ActiveSubscriptionPlan>(
      sql`
        select id, name, amount::text as amount, currency_code as currency,
               interval, interval_count
          from subscription_plans
         where org_id = ${orgId} and is_active
         order by name`,
      "objects",
    ),
  );
}
