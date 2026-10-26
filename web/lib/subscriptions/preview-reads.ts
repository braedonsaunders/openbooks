import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";

/** The customer entity a subscription belongs to, or null when it is not in the organization. */
export async function readSubscriptionCustomerScope(
  orgId: string,
  subscriptionId: string,
): Promise<{ subsidiaryId: string | null } | null> {
  return (
    (
      await db.execute<{ subsidiaryId: string | null }>(
        sql`
    select c.subsidiary_id as "subsidiaryId"
      from subscriptions s
      join parties c on c.id = s.customer_id and c.org_id = s.org_id
     where s.id = ${subscriptionId} and s.org_id = ${orgId}
  `,
        "objects",
      )
    )[0] ?? null
  );
}

/** A subscription's billing currency: its pinned plan version's, else the plan's. */
export async function readSubscriptionCurrency(
  orgId: string,
  subscriptionId: string,
): Promise<string | null> {
  return (
    (
      await db.execute<{ currency: string | null }>(
        sql`
    select coalesce(v.currency_code, p.currency_code) as "currency"
      from subscriptions s
      join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
      left join subscription_lifecycles l on l.subscription_id = s.id and l.org_id = s.org_id
      left join subscription_plan_versions v on v.id = l.plan_version_id and v.org_id = s.org_id
     where s.id = ${subscriptionId} and s.org_id = ${orgId}`,
        "objects",
      )
    )[0]?.currency ?? null
  );
}

/** A billing plan's amount, cadence and currency. */
export async function readSubscriptionPlan(orgId: string, planId: string) {
  return (
    (
      await db.execute<{
        amount: string;
        interval: string;
        intervalCount: number;
        currency: string | null;
      }>(
        sql`
    select amount::text as "amount", interval, interval_count as "intervalCount", currency_code as "currency"
      from subscription_plans where id = ${planId} and org_id = ${orgId}`,
        "objects",
      )
    )[0] ?? null
  );
}
