import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  SubscriptionError,
  contractRecurringAmounts,
  subscriptionPaidThrough,
  subscriptionRecurringRevenue,
  type Interval,
} from "@openbooks/engine/billing/subscription-billing";
import { add, mulDecimal, toUnits } from "@openbooks/engine/money/money";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { SubscriptionActionBody, executeSubscriptionAction } from "@/lib/subscriptions/actions";

export const runtime = "nodejs";

/** One subscription's monthly recurring revenue in its contract currency. */
type SubscriptionMrrRow = {
  mrr: string;
  planCurrency: unknown;
};

/**
 * Translate the subscription MRR card into the organization's functional
 * currency. Plan prices remain in their contract currency, but the card is a
 * single organization-currency scalar; unlike currencies must therefore use
 * the same dated spot-rate policy as AR's other foreign-currency readers.
 */
async function subscriptionMrrInOrgCurrency(
  orgId: string,
  orgCurrency: string,
  rows: readonly SubscriptionMrrRow[],
): Promise<string> {
  const asOf = await businessToday(orgId);
  const rates = new Map<string, string>();
  let total = "0.0000";
  for (const row of rows) {
    const amount = row.mrr;
    // A subscription earning nothing today needs no rate: a foreign plan with
    // no spot rate must not refuse the card for revenue that is not there.
    if (toUnits(amount) === 0n) continue;
    const sourceCurrency = String(row.planCurrency ?? orgCurrency)
      .trim()
      .toUpperCase();
    if (sourceCurrency === orgCurrency) {
      total = add(total, amount);
      continue;
    }
    let rate = rates.get(sourceCurrency);
    if (!rate) {
      const candidates = await db.execute<{ rate: string }>(
        sql`
        select rate::text from (
          select rate, as_of, 0 as priority
            from fx_rates
           where org_id = ${orgId} and from_currency = ${sourceCurrency}
             and to_currency = ${orgCurrency} and rate_type = 'spot'
             and as_of <= ${asOf}
          union all
          select (1 / rate)::numeric(19,10) as rate, as_of, 1 as priority
            from fx_rates
           where org_id = ${orgId} and from_currency = ${orgCurrency}
             and to_currency = ${sourceCurrency} and rate_type = 'spot'
             and as_of <= ${asOf}
        ) candidates
        order by as_of desc, priority asc
        limit 1
      `,
        "objects",
      );
      rate = candidates[0]?.rate;
      if (!rate) {
        throw new SubscriptionError(
          `no spot rate for subscription MRR ${sourceCurrency}→${orgCurrency} on or before ${asOf}`,
        );
      }
      rates.set(sourceCurrency, rate);
    }
    total = add(total, mulDecimal(amount, rate));
  }
  return total;
}

function customerSubsidiaryFilter(allowed: ReadonlySet<string> | null): SQL {
  if (allowed === null) return sql``;
  const ids = [...allowed];
  return ids.length
    ? sql`and (c.subsidiary_id is null or c.subsidiary_id = any(${`{${ids.join(",")}}`}::uuid[]))`
    : sql`and false`;
}

/**
 * Subscription billing API — plans + subscriptions. Gated by the
 * subscriptionBilling feature (404 when off). The engine runner bills due
 * subscriptions automatically; this is the management + bill-now surface.
 */
export const GET = defineRoute({
  permission: "ar.read",
  feature: "subscriptionBilling",
  handler: async ({ authz: routeAuthz }) => {
    const authz = routeAuthz;
    const orgId = authz.user.orgId;
    const asOf = await businessToday(orgId);
    const [plans, subs, org] = await Promise.all([
      db.execute(
        sql`
          select id, name, description, amount, currency_code as "currency", interval,
                 interval_count as "intervalCount", income_account_id as "incomeAccountId",
                 item_id as "itemId", tax_code_id as "taxCodeId", is_active as "isActive"
            from subscription_plans where org_id = ${orgId} order by name
        `,
        "objects",
      ),
      db.execute(
        sql`
          select s.id, s.customer_id as "customerId", s.plan_id as "planId", s.quantity,
                 s.price_override as "priceOverride", s.status, s.start_on as "startOn",
                 s.next_bill_on as "nextBillOn", s.auto_post as "autoPost", s.run_count as "runCount",
                 s.last_invoice_id as "lastInvoiceId", s.last_error as "lastError",
                 s.start_on::text as "startOnDate", s.next_bill_on::text as "nextBillOnDate",
                 s.canceled_on::text as "canceledOn",
                 exists(select 1 from subscription_lifecycles l where l.subscription_id = s.id and l.org_id = s.org_id) as "advancedLifecycle",
                 c.display_name as "customerName", p.name as "planName", p.amount as "planAmount",
                 p.interval, p.interval_count as "intervalCount", coalesce(v.currency_code, p.currency_code) as "planCurrency",
                 guard."guardedThrough"
            from subscriptions s
            join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
            left join parties c on c.id = s.customer_id and c.org_id = s.org_id
            left join subscription_lifecycles l on l.subscription_id = s.id and l.org_id = s.org_id
            left join subscription_plan_versions v on v.id = l.plan_version_id and v.org_id = s.org_id
            left join lateral (
              select max(inv.period_ends_on)::text as "guardedThrough"
                from subscription_period_invoices inv
               where inv.org_id = s.org_id and inv.subscription_id = s.id
            ) guard on true
           where s.org_id = ${orgId}
             ${customerSubsidiaryFilter(authz.allowedSubsidiaryIds)}
           order by s.created_at desc
        `,
        "objects",
      ),
      db.execute<{ baseCurrency: string }>(
        sql`
          select base_currency as "baseCurrency" from orgs where id = ${orgId}
        `,
        "objects",
      ),
    ]);
    const orgCurrency = String(org[0]?.baseCurrency ?? "")
      .trim()
      .toUpperCase();
    if (!orgCurrency) throw new SubscriptionError("organization currency is not configured");
    // Contract subscriptions earn their amended component prices, not the plan
    // price they were activated from, so MRR reads the same figure the invoices do.
    const contractAmounts = await contractRecurringAmounts(orgId, asOf);
    const earning = subs.map((s) => {
      const contract = contractAmounts.get(String(s.id)) ?? null;
      const paidThroughOn = subscriptionPaidThrough({
        startOn: String(s.startOnDate),
        nextBillOn: String(s.nextBillOnDate),
        billed: s.lastInvoiceId != null || s.guardedThrough != null,
        guardedThrough: s.guardedThrough == null ? null : String(s.guardedThrough),
      });
      const mrr = subscriptionRecurringRevenue({
        status: String(s.status),
        canceledOn: s.canceledOn == null ? null : String(s.canceledOn),
        asOf,
        priceOverride: s.priceOverride,
        planAmount: s.planAmount,
        contract,
        interval: s.interval as Interval,
        intervalCount: s.intervalCount,
        quantity: s.quantity,
      });
      return { row: s, mrr, paidThroughOn };
    });
    const subscriptions = earning.map(({ row, mrr, paidThroughOn }) => {
      const {
        startOnDate: _startOnDate,
        nextBillOnDate: _nextBillOnDate,
        guardedThrough: _guardedThrough,
        ...publicRow
      } = row;
      return { ...publicRow, mrr, paidThroughOn };
    });
    let mrr: string;
    try {
      mrr = await subscriptionMrrInOrgCurrency(
        orgId,
        orgCurrency,
        earning.map(({ row, mrr: rowMrr }) => ({
          mrr: rowMrr,
          planCurrency: row.planCurrency,
        })),
      );
    } catch (e) {
      if (e instanceof SubscriptionError) return apiErrorResponse(e);
      throw e;
    }
    return NextResponse.json({ plans, subscriptions, mrr });
  },
});

export const POST = defineRoute({
  permission: "ar.create",
  feature: "subscriptionBilling",
  body: SubscriptionActionBody,
  handler: async ({ authz, body }) => executeSubscriptionAction(authz, body),
});
