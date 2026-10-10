import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { add, mul } from "@openbooks/engine/src/money/money.ts";
import {
  SubscriptionError,
  loadSubRow,
  normalizeSubscriptionCadence,
  normalizeSubscriptionMoney,
  pendingSubscriptionPeriods,
  previewSubscriptionCatchUp,
} from "@openbooks/engine/src/billing/subscription-billing.ts";
import { apiErrorResponse } from "@/lib/api/error-response";
import { defineRoute } from "@/lib/api/route";
import { guardSubsidiaryScope } from "@/lib/authz";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/**
 * Catch-up preview for a subscription: the exact full billing periods from
 * next_bill_on through today, with the per-period amount and the estimated
 * total across all of them. Serves both a stored subscription and an
 * unsaved activation spec (plan + dates + quantity), so activation and
 * resume dialogs choose post-all/drafts/skip against the same list the run
 * will act on.
 */
export const GET = defineRoute({
  permission: "ar.read",
  feature: "subscriptionBilling",
  handler: async ({ request, authz }) => {
    const url = new URL(request.url);
    const get = (key: string): string | null => {
      const value = url.searchParams.get(key);
      return value === null || value.trim() === "" ? null : value;
    };
    const orgId = authz.user.orgId;
    const asOf = await businessToday(orgId);
    const subscriptionId = get("subscriptionId");
    try {
      if (subscriptionId) {
        const owned = (await db.execute<{ subsidiaryId: string | null }>(sql`
          select c.subsidiary_id as "subsidiaryId"
            from subscriptions s
            join parties c on c.id = s.customer_id and c.org_id = s.org_id
           where s.id = ${subscriptionId} and s.org_id = ${orgId}
        `));
        if (!owned.rows[0]) return notFound("record");
        const denied = guardSubsidiaryScope(authz, owned.rows[0].subsidiaryId, { orgWideNull: true });
        if (denied) return denied;
        const row = await loadSubRow(subscriptionId, orgId);
        const preview = await previewSubscriptionCatchUp(orgId, subscriptionId, asOf);
        const amount = mul(
          row.quantity,
          row.priceOverride ?? row.planAmount,
        );
        const planCurrency = (await db.execute<{ currency: string | null }>(sql`
          select coalesce(v.currency_code, p.currency_code) as "currency"
            from subscriptions s
            join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
            left join subscription_lifecycles l on l.subscription_id = s.id and l.org_id = s.org_id
            left join subscription_plan_versions v on v.id = l.plan_version_id and v.org_id = s.org_id
           where s.id = ${subscriptionId} and s.org_id = ${orgId}`)).rows[0]?.currency ?? null;
        return NextResponse.json({
          asOf,
          periods: preview.periods,
          truncated: preview.truncated,
          perPeriodAmount: amount,
          currency: planCurrency,
          estimatedTotal: totalAcross(amount, preview.periods.length),
        });
      }
      const planId = get("planId");
      const nextBillOn = get("nextBillOn");
      if (!planId || !nextBillOn) {
        return NextResponse.json({ error: "a subscription or plan with its next bill date is required" }, { status: 400 });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nextBillOn)) {
        return NextResponse.json({ error: "next bill date must be a calendar date (YYYY-MM-DD)" }, { status: 400 });
      }
      const plan = (await db.execute<{ amount: string; interval: string; intervalCount: number; currency: string | null }>(sql`
        select amount::text as "amount", interval, interval_count as "intervalCount", currency_code as "currency"
          from subscription_plans where id = ${planId} and org_id = ${orgId}`)).rows[0];
      if (!plan) return NextResponse.json({ error: "billing plan not found" }, { status: 404 });
      const cadence = normalizeSubscriptionCadence(plan.interval, plan.intervalCount);
      const quantity = normalizeSubscriptionMoney(get("quantity") ?? "1", "quantity", "positive");
      const priceOverrideRaw = get("priceOverride");
      const priceOverride = priceOverrideRaw != null
        ? normalizeSubscriptionMoney(priceOverrideRaw, "price override", "nonnegative")
        : null;
      const preview = pendingSubscriptionPeriods(
        {
          interval: cadence.interval,
          intervalCount: cadence.intervalCount,
          anchorDay: Number(nextBillOn.slice(8, 10)),
          nextBillOn,
        },
        asOf,
      );
      const amount = mul(quantity, priceOverride ?? plan.amount);
      return NextResponse.json({
        asOf,
        periods: preview.periods,
        truncated: preview.truncated,
        perPeriodAmount: amount,
        currency: plan.currency,
        estimatedTotal: totalAcross(amount, preview.periods.length),
      });
    } catch (e) {
      if (e instanceof SubscriptionError) return apiErrorResponse(e);
      throw e;
    }
  },
});

function totalAcross(perPeriod: string, count: number): string {
  let total = "0.0000";
  for (let i = 0; i < count; i++) total = add(total, perPeriod);
  return total;
}
