import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { addCalendarDays, businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import {
  monthlyRecurringRevenue,
  type Interval,
} from "@openbooks/engine/src/billing/subscription-billing.ts";
import { recurringTemplateScopeFilter } from "@openbooks/engine/src/billing/recurring.ts";
import { add, mulDecimal } from "@openbooks/engine/src/money/money.ts";
import { isFeatureEnabled } from "../features";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { subsidiaryScopeAllows } from "../authz";
import { disabledDocKinds } from "../documents";
import type { AssistantToolDef, ToolResult } from "./types";
import { truncateText } from "./types";
import { uuidInput, num, capList } from "./tools-shared";

/**
 * Subscription and recurring-billing read/search tools for the agentic
 * assistant. Plan/subscription reads carry the same `ar.read` gate and
 * `subscriptionBilling` feature flag as GET /api/subscriptions, with the
 * customer-subsidiary boundary the route enforces (an unassigned customer is
 * org-wide; a restricted caller only sees their allowed subsidiaries).
 * Recurring-schedule reads mirror GET /api/recurring (`documents.manage`,
 * no feature flag — the route has none).
 *
 * Per-row MRR uses the engine's `monthlyRecurringRevenue`; the org-currency
 * rollup uses the same dated spot-rate policy as the route's MRR card.
 */

const FEATURE_ERROR = "subscription_billing_feature_disabled";

async function featureOff(orgId: string): Promise<boolean> {
  return !(await isFeatureEnabled(orgId, "subscriptionBilling"));
}

async function orgCurrency(orgId: string): Promise<string | null> {
  const org = await db.execute<{ baseCurrency: string }>(sql`
    select base_currency as "baseCurrency" from orgs where id = ${orgId}
  `);
  const code = String(org.rows[0]?.baseCurrency ?? "").trim().toUpperCase();
  return code || null;
}

type MrrSource = {
  status: string;
  priceOverride: unknown;
  planAmount: unknown;
  interval: Interval;
  intervalCount: unknown;
  quantity: unknown;
  planCurrency: unknown;
};

function rowMrr(row: MrrSource): string {
  if (row.status !== "active") return "0.0000";
  return monthlyRecurringRevenue(
    String(row.priceOverride ?? row.planAmount ?? "0"),
    row.interval,
    Number(row.intervalCount ?? 1),
    String(row.quantity ?? "1"),
  );
}

/**
 * The route's MRR card translated into the org's currency. Throws the same
 * missing-rate refusal the route returns when no dated spot rate exists.
 */
async function mrrInOrgCurrency(
  orgId: string,
  orgCode: string,
  rows: readonly MrrSource[],
): Promise<string> {
  const asOf = await businessToday(orgId);
  const rates = new Map<string, string>();
  let total = "0.0000";
  for (const row of rows) {
    if (row.status !== "active") continue;
    const amount = rowMrr(row);
    const sourceCurrency = String(row.planCurrency ?? orgCode).trim().toUpperCase();
    if (sourceCurrency === orgCode) {
      total = add(total, amount);
      continue;
    }
    let rate = rates.get(sourceCurrency);
    if (!rate) {
      const candidates = await db.execute<{ rate: string }>(sql`
        select rate::text from (
          select rate, as_of, 0 as priority
            from fx_rates
           where org_id = ${orgId} and from_currency = ${sourceCurrency}
             and to_currency = ${orgCode} and rate_type = 'spot'
             and as_of <= ${asOf}
          union all
          select (1 / rate)::numeric(19,10) as rate, as_of, 1 as priority
            from fx_rates
           where org_id = ${orgId} and from_currency = ${orgCode}
             and to_currency = ${sourceCurrency} and rate_type = 'spot'
             and as_of <= ${asOf}
        ) candidates
        order by as_of desc, priority asc
        limit 1
      `);
      rate = candidates.rows[0]?.rate;
      if (!rate) {
        throw new Error(
          `no spot rate for subscription MRR ${sourceCurrency}→${orgCode} on or before ${asOf}`,
        );
      }
      rates.set(sourceCurrency, rate);
    }
    total = add(total, mulDecimal(amount, rate));
  }
  return total;
}

const SUBSCRIPTION_SELECT = sql`
  select s.id, s.customer_id as "customerId", s.plan_id as "planId", s.quantity,
         s.price_override as "priceOverride", s.status, s.start_on as "startOn",
         s.next_bill_on as "nextBillOn", s.canceled_on as "canceledOn",
         s.paused_on as "pausedOn", s.resume_on as "resumeOn",
         s.auto_post as "autoPost", s.run_count as "runCount",
         s.last_invoice_id as "lastInvoiceId", s.last_error as "lastError",
         s.dunning_state as "dunningState", s.dunning_stage_id as "dunningStageId",
         s.memo, s.created_at as "createdAt",
         exists(select 1 from subscription_lifecycles l where l.subscription_id = s.id and l.org_id = s.org_id) as "advancedLifecycle",
         c.display_name as "customerName", c.subsidiary_id as "customerSubsidiaryId",
         p.name as "planName", p.amount as "planAmount", p.currency_code as "planCurrency",
         p.interval, p.interval_count as "intervalCount"
    from subscriptions s
    join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
    left join parties c on c.id = s.customer_id and c.org_id = s.org_id`;

function subscriptionRow(r: Record<string, unknown>) {
  return {
    id: r.id,
    customerId: r.customerId,
    customerName: r.customerName,
    planId: r.planId,
    planName: r.planName,
    quantity: r.quantity == null ? null : num(r.quantity),
    status: r.status,
    startOn: r.startOn,
    nextBillOn: r.nextBillOn,
    canceledOn: r.canceledOn,
    pausedOn: r.pausedOn,
    resumeOn: r.resumeOn,
    autoPost: r.autoPost,
    runCount: r.runCount,
    lastInvoiceId: r.lastInvoiceId,
    lastError: r.lastError == null ? null : truncateText(String(r.lastError), 300),
    dunningState: r.dunningState,
    advancedLifecycle: r.advancedLifecycle,
    planCurrency: r.planCurrency,
    planInterval: r.interval,
    mrr: num(rowMrr(r as unknown as MrrSource)),
    memo: r.memo == null ? null : truncateText(String(r.memo), 300),
  };
}

const listSubscriptionPlans: AssistantToolDef = {
  name: "list_subscription_plans",
  description:
    "List subscription plans: name, amount and currency, billing interval, and active flag. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["ar.read"] },
  feature: "subscriptionBilling",
  inputSchema: z.object({
    activeOnly: z.boolean().optional().describe("True = active plans only (default false = every plan)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as { activeOnly?: boolean };
    const plans = await db.execute<Record<string, unknown>>(sql`
      select id, name, description, amount, currency_code as "currency", interval,
             interval_count as "intervalCount", is_active as "isActive"
        from subscription_plans
       where org_id = ${authz.user.orgId}
         ${a.activeOnly ? sql` and is_active` : sql``}
       order by name
    `);
    const capped = capList(
      plans.rows.map((p) => ({
        planId: p.id,
        name: p.name,
        description: p.description == null ? null : truncateText(String(p.description), 300),
        amount: num(p.amount),
        currency: p.currency,
        interval: p.interval,
        intervalCount: p.intervalCount,
        isActive: p.isActive,
      })),
    );
    return {
      ok: true,
      data: {
        returned: capped.items.length,
        total: plans.rows.length,
        truncated: capped.truncated,
        plans: capped.items,
        href: "/collections",
      },
    };
  },
};

const listSubscriptionsSchema = z.object({
  query: z.string().max(100).optional().describe("Substring over the customer name"),
  status: z.enum(["active", "paused", "canceled"]).optional().describe("Subscription status; omit for every status"),
  planId: uuidInput.optional().describe("Plan id; omit for every plan"),
  dunningState: z.string().max(40).optional().describe("Dunning state (e.g. current, overdue); omit for every state"),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50); aggregates always cover ALL matches"),
});

const listSubscriptions: AssistantToolDef = {
  name: "list_subscriptions",
  description:
    "List subscriptions with per-row MRR: customer, plan, status, billing dates, dunning state, and last billing error. Returns a capped page plus counts by status and MRR totals over ALL matches. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["ar.read"] },
  feature: "subscriptionBilling",
  inputSchema: listSubscriptionsSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as z.infer<typeof listSubscriptionsSchema>;
    const limit = Math.min(a.limit ?? 50, 200);
    const like = a.query ? `%${a.query}%` : null;
    const filters = sql.join(
      [
        like ? sql` and c.display_name ilike ${like}` : sql``,
        a.status ? sql` and s.status = ${a.status}` : sql``,
        a.planId ? sql` and s.plan_id = ${a.planId}` : sql``,
        a.dunningState ? sql` and s.dunning_state = ${a.dunningState}` : sql``,
      ],
      sql``,
    );
    // Same customer boundary as GET /api/subscriptions: an unassigned
    // customer is org-wide; a restricted caller only sees their subsidiaries.
    const scope = subsidiaryVisibleFilter(sql`c.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true });
    const [page, byStatus, mrrRows] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        ${SUBSCRIPTION_SELECT}
         where s.org_id = ${authz.user.orgId}${filters}${scope}
         order by s.created_at desc
         limit ${limit}
      `),
      db.execute<Record<string, unknown>>(sql`
        select s.status, count(*)::int as count
          from subscriptions s
          left join parties c on c.id = s.customer_id and c.org_id = s.org_id
         where s.org_id = ${authz.user.orgId}${filters}${scope}
         group by s.status order by s.status
      `),
      db.execute<MrrSource & Record<string, unknown>>(sql`
        select s.status, s.price_override as "priceOverride", p.amount as "planAmount",
               p.interval, p.interval_count as "intervalCount", s.quantity,
               p.currency_code as "planCurrency"
          from subscriptions s
          join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
          left join parties c on c.id = s.customer_id and c.org_id = s.org_id
         where s.org_id = ${authz.user.orgId}${filters}${scope}
      `),
    ]);
    const capped = capList(page.rows.map(subscriptionRow));
    const mrrByCurrency = new Map<string, string>();
    for (const row of mrrRows.rows) {
      if (row.status !== "active") continue;
      const code = String(row.planCurrency ?? "").trim().toUpperCase() || "UNKNOWN";
      mrrByCurrency.set(code, add(mrrByCurrency.get(code) ?? "0.0000", rowMrr(row)));
    }
    const currency = await orgCurrency(authz.user.orgId);
    let mrrOrgTotal: number | null = null;
    let mrrNote: string | undefined;
    if (currency) {
      try {
        mrrOrgTotal = num(await mrrInOrgCurrency(authz.user.orgId, currency, mrrRows.rows));
      } catch (error) {
        // The route fails the whole read on a missing rate; the tool still
        // returns every row and the per-currency totals with the reason noted.
        mrrNote = error instanceof Error ? error.message : "mrr conversion unavailable";
      }
    }
    return {
      ok: true,
      data: {
        returned: capped.items.length,
        total: byStatus.rows.reduce((n, r) => n + Number(r.count ?? 0), 0),
        truncated: capped.truncated,
        subscriptions: capped.items,
        byStatus: byStatus.rows.map((r) => ({ status: r.status, count: Number(r.count ?? 0) })),
        mrrByCurrency: [...mrrByCurrency].map(([code, amount]) => ({ currency: code, mrr: num(amount) })),
        ...(currency ? { orgCurrency: currency, mrrOrgTotal } : {}),
        ...(mrrNote ? { mrrNote } : {}),
        href: "/collections",
      },
    };
  },
};

const getSubscription: AssistantToolDef = {
  name: "get_subscription",
  description:
    "One subscription's full detail: customer, plan and price, lifecycle dates, billing state, dunning state and stage, recent lifecycle events, billed period invoices, and the advanced contract term when present. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["ar.read"] },
  feature: "subscriptionBilling",
  inputSchema: z.object({ subscriptionId: uuidInput.describe("Subscription id from list_subscriptions") }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as { subscriptionId: string };
    const rows = await db.execute<Record<string, unknown>>(sql`
      ${SUBSCRIPTION_SELECT}
       where s.id = ${a.subscriptionId} and s.org_id = ${authz.user.orgId}
    `);
    const head = rows.rows[0];
    // A subscription of a customer outside the caller's subsidiary scope is
    // indistinguishable from a missing one — the answer the route gives.
    if (!head || !subsidiaryScopeAllows(authz.allowedSubsidiaryIds, head.customerSubsidiaryId as string | null, { orgWideNull: true })) {
      return { ok: false, error: "subscription_not_found" };
    }
    const [events, invoices, dunning, lifecycle] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        select kind, occurred_on::text as occurred_on, payload, invoice_id as "invoiceId"
          from subscription_events
         where org_id = ${authz.user.orgId} and subscription_id = ${a.subscriptionId}
         order by occurred_on desc, created_at desc limit 20
      `),
      db.execute<Record<string, unknown>>(sql`
        select pi.period_starts_on::text as "periodStartsOn", pi.period_ends_on::text as "periodEndsOn",
               pi.contract_revision as "contractRevision", pi.invoice_id as "invoiceId",
               d.document_number as "invoiceNumber", d.status as "invoiceStatus",
               d.document_date::text as "invoiceDate", d.total as "invoiceTotal", d.currency as "invoiceCurrency"
          from subscription_period_invoices pi
          join documents d on d.id = pi.invoice_id and d.org_id = pi.org_id
         where pi.org_id = ${authz.user.orgId} and pi.subscription_id = ${a.subscriptionId}
         order by pi.period_starts_on desc limit 20
      `),
      db.execute<Record<string, unknown>>(sql`
        select dl.sent_at, dl.channel, dl.status, dl.amount_due as "amountDue", dl.currency_code as currency,
               dl.to_email as "toEmail", dl.detail, st.name as "stageName", dl.document_id as "documentId"
          from dunning_log dl
          left join dunning_stages st on st.id = dl.stage_id and st.org_id = dl.org_id
         where dl.org_id = ${authz.user.orgId}
           and dl.document_id in (
             select pi.invoice_id from subscription_period_invoices pi
              where pi.org_id = ${authz.user.orgId} and pi.subscription_id = ${a.subscriptionId}
           )
         order by dl.sent_at desc limit 10
      `),
      // soft-feature: the advanced term section only exists while the
      // advancedSubscriptions switch is on; otherwise it is omitted.
      (await isFeatureEnabled(authz.user.orgId, "advancedSubscriptions"))
        ? db.execute<Record<string, unknown>>(sql`
          select l.term_starts_on::text as "termStartsOn", l.term_ends_on::text as "termEndsOn",
                 l.trial_ends_on::text as "trialEndsOn", l.billing_timing as "billingTiming",
                 l.renewal_policy as "renewalPolicy", l.renewal_term_months as "renewalTermMonths",
                 l.renewal_on::text as "renewalOn", l.contract_revision as "contractRevision",
                 (select coalesce(jsonb_agg(jsonb_build_object('amendmentType', am.amendment_type, 'effectiveOn', am.effective_on,
                    'status', am.status, 'reason', am.reason) order by am.amendment_number desc), '[]'::jsonb)
                    from subscription_amendments am
                   where am.org_id = l.org_id and am.subscription_id = l.subscription_id) as amendments
            from subscription_lifecycles l
           where l.org_id = ${authz.user.orgId} and l.subscription_id = ${a.subscriptionId}
        `)
        : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
    ]);
    return {
      ok: true,
      data: {
        subscription: subscriptionRow(head),
        events: capList(events.rows, 20).items,
        periodInvoices: invoices.rows.map((i) => ({ ...i, invoiceTotal: num(i.invoiceTotal) })),
        dunningLog: dunning.rows.map((d) => ({ ...d, amountDue: num(d.amountDue) })),
        ...(lifecycle.rows[0] ? { advancedTerm: lifecycle.rows[0] } : {}),
        href: "/collections",
      },
    };
  },
};

const subscriptionMrr: AssistantToolDef = {
  name: "subscription_mrr",
  description:
    "Recurring-revenue readout: active subscription count, MRR total in the org currency, MRR by plan, dunning-state breakdown of actives, and trailing-30-day new / canceled / paused churn inputs with lost MRR. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["ar.read"] },
  feature: "subscriptionBilling",
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const today = await businessToday(authz.user.orgId);
    const churnSince = addCalendarDays(today, -30);
    const scope = subsidiaryVisibleFilter(sql`c.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true });
    const [mrrRows, byPlan, byDunning, churn] = await Promise.all([
      db.execute<MrrSource & Record<string, unknown>>(sql`
        select s.status, s.price_override as "priceOverride", p.amount as "planAmount",
               p.interval, p.interval_count as "intervalCount", s.quantity,
               p.currency_code as "planCurrency"
          from subscriptions s
          join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
          left join parties c on c.id = s.customer_id and c.org_id = s.org_id
         where s.org_id = ${authz.user.orgId}${scope}
      `),
      db.execute<Record<string, unknown>>(sql`
        select p.name as "planName", p.currency_code as currency, count(*)::int as count,
               s.status, s.price_override as "priceOverride", p.amount as "planAmount",
               p.interval, p.interval_count as "intervalCount", s.quantity
          from subscriptions s
          join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
          left join parties c on c.id = s.customer_id and c.org_id = s.org_id
         where s.org_id = ${authz.user.orgId}${scope}
         group by p.name, p.currency_code, s.status, s.price_override, p.amount, p.interval, p.interval_count, s.quantity
         order by p.name
      `),
      db.execute<Record<string, unknown>>(sql`
        select s.dunning_state as "dunningState", count(*)::int as count
          from subscriptions s
          left join parties c on c.id = s.customer_id and c.org_id = s.org_id
         where s.org_id = ${authz.user.orgId} and s.status = 'active'${scope}
         group by s.dunning_state order by s.dunning_state
      `),
      db.execute<Record<string, unknown>>(sql`
        select s.status, s.price_override as "priceOverride", p.amount as "planAmount",
               p.interval, p.interval_count as "intervalCount", s.quantity,
               p.currency_code as "planCurrency",
               (s.created_at >= now() - interval '30 days') as "isNew",
               (s.canceled_on >= ${churnSince}::date) as "canceledRecent",
               (s.paused_on >= ${churnSince}::date) as "pausedRecent"
          from subscriptions s
          join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
          left join parties c on c.id = s.customer_id and c.org_id = s.org_id
         where s.org_id = ${authz.user.orgId}${scope}
      `),
    ]);
    const activeRows = mrrRows.rows.filter((r) => r.status === "active");
    const currency = await orgCurrency(authz.user.orgId);
    let mrrOrgTotal: number | null = null;
    let mrrNote: string | undefined;
    if (currency) {
      try {
        mrrOrgTotal = num(await mrrInOrgCurrency(authz.user.orgId, currency, mrrRows.rows));
      } catch (error) {
        mrrNote = error instanceof Error ? error.message : "mrr conversion unavailable";
      }
    }
    const mrrByPlan = new Map<string, { currency: string; mrr: string; count: number }>();
    for (const row of byPlan.rows) {
      if (row.status !== "active") continue;
      const key = `${String(row.planName)}||${String(row.currency ?? "")}`;
      const prev = mrrByPlan.get(key) ?? { currency: String(row.currency ?? ""), mrr: "0.0000", count: 0 };
      prev.mrr = add(prev.mrr, rowMrr(row as unknown as MrrSource));
      prev.count += Number(row.count ?? 0);
      mrrByPlan.set(key, prev);
    }
    let newCount = 0;
    let canceledCount = 0;
    let pausedCount = 0;
    const lostByCurrency = new Map<string, string>();
    for (const row of churn.rows) {
      if (row.isNew) newCount += 1;
      if (row.canceledRecent) {
        canceledCount += 1;
        const code = String(row.planCurrency ?? "").trim().toUpperCase() || "UNKNOWN";
        lostByCurrency.set(code, add(lostByCurrency.get(code) ?? "0.0000", rowMrr(row as unknown as MrrSource)));
      }
      if (row.pausedRecent) pausedCount += 1;
    }
    return {
      ok: true,
      data: {
        asOf: today,
        activeCount: activeRows.length,
        ...(currency ? { orgCurrency: currency, mrrOrgTotal } : {}),
        ...(mrrNote ? { mrrNote } : {}),
        mrrByPlan: [...mrrByPlan].map(([key, v]) => ({
          planName: key.split("||")[0],
          currency: v.currency,
          mrr: num(v.mrr),
          activeCount: v.count,
        })),
        byDunningState: byDunning.rows.map((r) => ({ dunningState: r.dunningState, count: Number(r.count ?? 0) })),
        churnTrailing30Days: {
          newCount,
          canceledCount,
          pausedCount,
          lostMrrByCurrency: [...lostByCurrency].map(([code, amount]) => ({ currency: code, mrr: num(amount) })),
        },
        href: "/collections",
      },
    };
  },
};

const subscriptionUpcomingInvoicesSchema = z.object({
  withinDays: z.number().int().min(1).max(365).optional().describe("Billing window in days from today (default 30)"),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50); totals always cover ALL matches"),
});

const subscriptionUpcomingInvoices: AssistantToolDef = {
  name: "subscription_upcoming_invoices",
  description:
    "Upcoming recurring invoices: active subscriptions billing inside the window with expected amounts (pre-proration), plus totals per currency over ALL matches. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["ar.read"] },
  feature: "subscriptionBilling",
  inputSchema: subscriptionUpcomingInvoicesSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as z.infer<typeof subscriptionUpcomingInvoicesSchema>;
    const withinDays = a.withinDays ?? 30;
    const limit = Math.min(a.limit ?? 50, 200);
    const today = await businessToday(authz.user.orgId);
    const through = addCalendarDays(today, withinDays);
    const scope = subsidiaryVisibleFilter(sql`c.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true });
    const [page, totals] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        select s.id, s.next_bill_on::text as "nextBillOn", c.display_name as "customerName",
               p.name as "planName", s.quantity, s.price_override as "priceOverride",
               p.amount as "planAmount", p.currency_code as currency, s.last_error as "lastError"
          from subscriptions s
          join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
          left join parties c on c.id = s.customer_id and c.org_id = s.org_id
         where s.org_id = ${authz.user.orgId} and s.status = 'active'
           and s.next_bill_on <= ${through}::date${scope}
         order by s.next_bill_on, c.display_name
         limit ${limit}
      `),
      db.execute<Record<string, unknown>>(sql`
        select p.currency_code as currency, count(*)::int as count,
               coalesce(sum(s.quantity * coalesce(s.price_override, p.amount)), 0)::text as expected
          from subscriptions s
          join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
          left join parties c on c.id = s.customer_id and c.org_id = s.org_id
         where s.org_id = ${authz.user.orgId} and s.status = 'active'
           and s.next_bill_on <= ${through}::date${scope}
         group by p.currency_code order by p.currency_code
      `),
    ]);
    const capped = capList(
      page.rows.map((r) => ({
        subscriptionId: r.id,
        nextBillOn: r.nextBillOn,
        customerName: r.customerName,
        planName: r.planName,
        quantity: num(r.quantity),
        currency: r.currency,
        expectedAmount: num(mulDecimal(String(r.priceOverride ?? r.planAmount ?? 0), String(r.quantity ?? 1))),
        lastError: r.lastError == null ? null : truncateText(String(r.lastError), 200),
      })),
    );
    return {
      ok: true,
      data: {
        asOf: today,
        withinDays,
        returned: capped.items.length,
        total: totals.rows.reduce((n, r) => n + Number(r.count ?? 0), 0),
        truncated: capped.truncated,
        upcoming: capped.items,
        totalsByCurrency: totals.rows.map((r) => ({
          currency: r.currency,
          count: Number(r.count ?? 0),
          expectedAmount: num(r.expected),
        })),
        href: "/collections",
      },
    };
  },
};

const listRecurringSchedulesSchema = z.object({
  activeOnly: z.boolean().optional().describe("True = active schedules only (default false = every schedule)"),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50)"),
});

const listRecurringSchedules: AssistantToolDef = {
  name: "list_recurring_schedules",
  description:
    "List recurring document schedules (template + cadence): next run, auto-post, run count, last error, and template party. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["documents.manage"] },
  inputSchema: listRecurringSchedulesSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as z.infer<typeof listRecurringSchedulesSchema>;
    const limit = Math.min(a.limit ?? 50, 200);
    const hidden = new Set(await disabledDocKinds(authz.user.orgId));
    const rows = await db.execute<Record<string, unknown>>(sql`
      select rs.id, rs.cadence, rs.cron, rs.next_run_on as "nextRunOn", rs.ends_on as "endsOn",
             rs.auto_post as "autoPost", rs.is_active as "isActive", rs.run_count as "runCount",
             rs.last_run_at as "lastRunAt", rs.last_document_id as "lastDocumentId", rs.last_error as "lastError",
             coalesce(rs.name, d.document_number) as "name", d.kind as "templateKind",
             d.document_number as "templateNumber", p.display_name as "partyName"
        from recurring_schedules rs
        join documents d on d.id = rs.template_document_id and d.org_id = rs.org_id
        left join parties p on p.id = d.party_id and p.org_id = rs.org_id
       where rs.org_id = ${authz.user.orgId}
         ${a.activeOnly ? sql` and rs.is_active` : sql``}
         ${recurringTemplateScopeFilter(authz.user.orgId, sql`d.id`, sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)}
       order by rs.is_active desc, rs.next_run_on
       limit ${limit + 1}
    `);
    // Same hidden-kind filtering as GET /api/recurring, applied after the
    // capped fetch so the page matches the screen's.
    const visible = rows.rows.filter((row) => !hidden.has(String(row.templateKind)));
    const capped = capList(
      visible.slice(0, limit).map((r) => ({
        scheduleId: r.id,
        name: r.name,
        cadence: r.cadence,
        cron: r.cron,
        nextRunOn: r.nextRunOn,
        endsOn: r.endsOn,
        autoPost: r.autoPost,
        isActive: r.isActive,
        runCount: r.runCount,
        lastRunAt: r.lastRunAt,
        lastDocumentId: r.lastDocumentId,
        lastError: r.lastError == null ? null : truncateText(String(r.lastError), 300),
        templateKind: r.templateKind,
        templateNumber: r.templateNumber,
        partyName: r.partyName,
      })),
    );
    return {
      ok: true,
      data: {
        returned: capped.items.length,
        truncated: capped.truncated || visible.length > limit,
        schedules: capped.items,
        href: "/collections",
      },
    };
  },
};

export const SUBSCRIPTION_TOOLS: AssistantToolDef[] = [
  listSubscriptionPlans,
  listSubscriptions,
  getSubscription,
  subscriptionMrr,
  subscriptionUpcomingInvoices,
  listRecurringSchedules,
];
