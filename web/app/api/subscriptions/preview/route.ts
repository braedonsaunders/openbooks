import { NextResponse } from "next/server";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { add, mul } from "@openbooks/engine/money/money";
import {
  SubscriptionError,
  loadSubRow,
  normalizeSubscriptionCadence,
  normalizeSubscriptionMoney,
  pendingSubscriptionPeriods,
  previewSubscriptionCatchUp,
} from "@openbooks/engine/billing/subscription-billing";
import { apiErrorResponse } from "@/lib/api/error-response";
import { defineRoute } from "@/lib/api/route";
import { guardSubsidiaryScope } from "@/lib/authz";
import { notFound } from "@/lib/api/responses";
import {
  readSubscriptionCurrency,
  readSubscriptionCustomerScope,
  readSubscriptionPlan,
} from "@/lib/subscriptions/preview-reads";

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
        const owned = await readSubscriptionCustomerScope(orgId, subscriptionId);
        if (!owned) return notFound("record");
        const denied = guardSubsidiaryScope(authz, owned.subsidiaryId, { orgWideNull: true });
        if (denied) return denied;
        const row = await loadSubRow(subscriptionId, orgId);
        const preview = await previewSubscriptionCatchUp(orgId, subscriptionId, asOf);
        const amount = mul(row.quantity, row.priceOverride ?? row.planAmount);
        const planCurrency = await readSubscriptionCurrency(orgId, subscriptionId);
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
        return NextResponse.json(
          { error: "a subscription or plan with its next bill date is required" },
          { status: 400 },
        );
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nextBillOn)) {
        return NextResponse.json(
          { error: "next bill date must be a calendar date (YYYY-MM-DD)" },
          { status: 400 },
        );
      }
      const plan = await readSubscriptionPlan(orgId, planId);
      if (!plan) return NextResponse.json({ error: "billing plan not found" }, { status: 404 });
      const cadence = normalizeSubscriptionCadence(plan.interval, plan.intervalCount);
      const quantity = normalizeSubscriptionMoney(get("quantity") ?? "1", "quantity", "positive");
      const priceOverrideRaw = get("priceOverride");
      const priceOverride =
        priceOverrideRaw != null
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
