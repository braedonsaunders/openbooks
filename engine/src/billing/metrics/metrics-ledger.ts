import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  add,
  cmp,
  mul,
  mulDecimal,
  neg,
} from "../../money/money.ts";
import {
  lockAndCheckOrgFeature,
  orgFeatureEnabled,
  acquireOrgFeatureGateLock,
} from "../../organization/org-feature-lock.ts";
import { arePeriodModulesOpen } from "../../periods/period-policy.ts";
import {
  db,
  withBypassContext,
  withOrgContext,
  withOrgTransaction,
  type SqlExecutor,
} from "../../platform/db.ts";
import { businessToday } from "../../platform/business-date.ts";
import {
  monthlyRecurringRevenue,
  type Interval,
} from "../subscription-billing.ts";
import { UsageBillingError } from "../usage/errors.ts";

const FEATURES_REMEDY = "Enable SaaS metrics in Company Settings → Features.";
const CLOSED_PERIOD_REMEDY =
  "Reopen the period through the period-close flow to compute a new snapshot, or accept the frozen month and leave its recorded facts unchanged.";

export interface SaasMetricsDefinitions {
  orgId: string;
  evergreenBookingMonths: string;
  billingsUsePreTaxSubtotal: boolean;
  customerCreditsReduceBillings: boolean;
}

/** Read the tenant's SaaS metrics policy, using the former resolver values for unset fields. */
export function saasMetricsDefinitions(orgId: string, rawSettings: unknown): SaasMetricsDefinitions {
  const settings = rawSettings !== null && typeof rawSettings === "object" && !Array.isArray(rawSettings)
    ? rawSettings as Record<string, unknown>
    : {};
  const stored = settings.saasMetrics;
  const definitions = stored === undefined
    ? {}
    : stored !== null && typeof stored === "object" && !Array.isArray(stored)
      ? stored as Record<string, unknown>
      : null;
  if (!definitions) {
    throw new UsageBillingError(
      "saas_metrics_definition_invalid",
      "SaaS metrics definitions must be stored as an object.",
      "Correct the definitions in Company Settings → Setup → Company, then recompute SaaS metrics.",
      { field: "saasMetrics" },
    );
  }
  const evergreenBookingMonths = definitions.evergreenBookingMonths ?? "12";
  if (typeof evergreenBookingMonths !== "string" || !/^[1-9]\d*$/.test(evergreenBookingMonths)) {
    throw new UsageBillingError(
      "saas_metrics_definition_invalid",
      "Evergreen booking term must be a positive whole number of months.",
      "Enter a positive whole number of months in Company Settings → Setup → Company.",
      { field: "evergreenBookingMonths" },
    );
  }
  const billingsUsePreTaxSubtotal = definitions.billingsUsePreTaxSubtotal ?? true;
  if (typeof billingsUsePreTaxSubtotal !== "boolean") {
    throw new UsageBillingError(
      "saas_metrics_definition_invalid",
      "Billings basis must be a boolean setting.",
      "Choose the billings basis in Company Settings → Setup → Company.",
      { field: "billingsUsePreTaxSubtotal" },
    );
  }
  const customerCreditsReduceBillings = definitions.customerCreditsReduceBillings ?? true;
  if (typeof customerCreditsReduceBillings !== "boolean") {
    throw new UsageBillingError(
      "saas_metrics_definition_invalid",
      "Customer-credit treatment must be a boolean setting.",
      "Choose the customer-credit treatment in Company Settings → Setup → Company.",
      { field: "customerCreditsReduceBillings" },
    );
  }
  return {
    orgId,
    evergreenBookingMonths,
    billingsUsePreTaxSubtotal,
    customerCreditsReduceBillings,
  };
}

export interface SaasMetricsRecomputeResult {
  orgId: string;
  month: string;
  subscriptionRows: number;
  subsidiaryRows: number;
  frozen: boolean;
}

export interface SaasMetricsScanTargets {
  enabledOrgIds: string[];
  skippedFeatureOffOrgIds: string[];
}

type SubscriptionSource = {
  id: string;
  customer_id: string;
  trusted_subsidiary_id: string | null;
  customer_subsidiary_id: string | null;
  root_subsidiary_id: string | null;
  status: string;
  start_on: string;
  canceled_on: string | null;
  paused_on: string | null;
  resume_on: string | null;
  price_override: string | null;
  plan_amount: string;
  interval: Interval;
  interval_count: number;
  quantity: string;
  plan_currency: string | null;
  renewal_term_months: number | null;
  term_starts_on: string | null;
  term_ends_on: string | null;
};

type HistoryRow = {
  subscription_id: string;
  customer_id: string;
  subsidiary_id: string;
  month: string;
  cohort_month: string;
  mrr_end: string;
};

type MonthlySubscriptionFact = {
  orgId: string;
  subsidiaryId: string;
  customerId: string;
  subscriptionId: string;
  month: string;
  cohortMonth: string;
  mrrStart: string;
  mrrEnd: string;
  newMrr: string;
  expansionMrr: string;
  contractionMrr: string;
  churnedMrr: string;
  reactivationMrr: string;
  movement: "new" | "expansion" | "contraction" | "churn" | "reactivation" | "flat";
  recognizedRevenue: string;
  deferredDelta: string;
  booking: string;
};

type RevenueRow = { subscription_id: string; revenue: string };
type DeferredRow = { subscription_id: string; deferred_delta: string; deferred_balance: string };
type LedgerFactRow = { subsidiary_id: string; revenue: string; cogs: string };
type BillingRow = { subsidiary_id: string; billings: string };
type SubsidiaryRow = { id: string };
type PeriodBookRow = { period_id: string; book_id: string };

function refusal(
  code: string,
  message: string,
  remedy: string,
  options?: { field?: string | null; status?: 422 | 409 },
): UsageBillingError {
  return new UsageBillingError(code, message, remedy, options);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function moneySum(values: readonly string[]): string {
  return values.reduce((total, value) => add(total, value), "0.0000");
}

function monthOrdinal(month: string): number {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return year * 12 + monthNumber - 1;
}

function monthFromOrdinal(ordinal: number): string {
  const year = Math.floor(ordinal / 12);
  const month = ordinal % 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

function monthStartForDate(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function statusAtMonthEnd(source: SubscriptionSource, monthEnd: string): "active" | "paused" | "canceled" {
  switch (source.status) {
    case "active":
    case "paused":
    case "canceled": {
      const resumedAfterCancel = source.canceled_on !== null
        && source.resume_on !== null
        && source.resume_on > source.canceled_on
        && source.resume_on <= monthEnd;
      const canceled = source.canceled_on !== null
        && source.canceled_on <= monthEnd
        && !resumedAfterCancel;
      if (canceled) return "canceled";
      const resumedAfterPause = source.paused_on !== null
        && source.resume_on !== null
        && source.resume_on > source.paused_on
        && source.resume_on <= monthEnd;
      const paused = source.paused_on !== null && source.paused_on <= monthEnd && !resumedAfterPause;
      if (paused) return "paused";
      if (source.status === "canceled" && source.canceled_on === null) return "canceled";
      if (source.status === "paused" && source.paused_on === null) return "paused";
      return "active";
    }
    default:
      throw refusal(
        "saas_metrics_subscription_status_invalid",
        `Subscription ${source.id} has unsupported status "${source.status}" and cannot be included in SaaS metrics.`,
        "Set the subscription to Active, Paused, or Canceled in its subscription record, then recompute the month.",
        { field: "status" },
      );
  }
}

function chooseMovement(args: {
  mrrStart: string;
  mrrEnd: string;
  previousMonthRecorded: boolean;
  priorPositive: boolean;
}): MonthlySubscriptionFact["movement"] {
  const { mrrStart, mrrEnd, previousMonthRecorded, priorPositive } = args;
  if (cmp(mrrStart, "0") > 0 && cmp(mrrEnd, "0") === 0) return "churn";
  if (cmp(mrrStart, "0") === 0 && cmp(mrrEnd, "0") > 0) {
    if (previousMonthRecorded && priorPositive) return "reactivation";
    return priorPositive ? "reactivation" : "new";
  }
  if (cmp(mrrEnd, mrrStart) > 0) return "expansion";
  if (cmp(mrrEnd, mrrStart) < 0) return "contraction";
  return "flat";
}

function movementAmounts(
  movement: MonthlySubscriptionFact["movement"],
  mrrStart: string,
  mrrEnd: string,
): Pick<MonthlySubscriptionFact, "newMrr" | "expansionMrr" | "contractionMrr" | "churnedMrr" | "reactivationMrr"> {
  const delta = add(mrrEnd, neg(mrrStart));
  switch (movement) {
    case "new":
      return { newMrr: mrrEnd, expansionMrr: "0.0000", contractionMrr: "0.0000", churnedMrr: "0.0000", reactivationMrr: "0.0000" };
    case "expansion":
      return { newMrr: "0.0000", expansionMrr: delta, contractionMrr: "0.0000", churnedMrr: "0.0000", reactivationMrr: "0.0000" };
    case "contraction":
      return { newMrr: "0.0000", expansionMrr: "0.0000", contractionMrr: neg(delta), churnedMrr: "0.0000", reactivationMrr: "0.0000" };
    case "churn":
      return { newMrr: "0.0000", expansionMrr: "0.0000", contractionMrr: "0.0000", churnedMrr: mrrStart, reactivationMrr: "0.0000" };
    case "reactivation":
      return { newMrr: "0.0000", expansionMrr: "0.0000", contractionMrr: "0.0000", churnedMrr: "0.0000", reactivationMrr: mrrEnd };
    case "flat":
      return { newMrr: "0.0000", expansionMrr: "0.0000", contractionMrr: "0.0000", churnedMrr: "0.0000", reactivationMrr: "0.0000" };
  }
}

async function spotRate(
  executor: SqlExecutor,
  orgId: string,
  fromCurrency: string,
  toCurrency: string,
  onDate: string,
): Promise<string> {
  if (fromCurrency === toCurrency) return "1.0000000000";
  const result = await executor.execute<{ rate: string; as_of: string }>(sql`
    select rate::text, as_of::text from (
      select rate, as_of, 0 as priority from fx_rates
       where org_id = ${orgId} and from_currency = ${fromCurrency}
         and to_currency = ${toCurrency} and rate_type = 'spot' and as_of <= ${onDate}
      union all
      select (1 / rate)::numeric(19,10) as rate, as_of, 1 as priority from fx_rates
       where org_id = ${orgId} and from_currency = ${toCurrency}
         and to_currency = ${fromCurrency} and rate_type = 'spot' and as_of <= ${onDate}
    ) rates order by as_of desc, priority asc limit 1
  `);
  const rate = result.rows[0]?.rate;
  if (!rate) {
    throw refusal(
      "saas_metrics_fx_rate_missing",
      `No spot FX rate is available for subscription MRR ${fromCurrency}→${toCurrency} on or before ${onDate}.`,
      `Enable Multi-currency in Company Settings → Features if needed, add the dated spot rate ${fromCurrency}→${toCurrency} on or before ${onDate} under Company Settings → Setup → FX rates, then recompute the month.`,
      { field: "plan_currency" },
    );
  }
  return rate;
}

async function monthCloseState(
  executor: SqlExecutor,
  orgId: string,
  month: string,
  subsidiaryIds: string[],
): Promise<{ open: boolean; periodIds: string[] }> {
  const monthData = await executor.execute<{ month_end: string }>(sql`
    select (${month}::date + interval '1 month - 1 day')::date::text as month_end
  `);
  const monthEnd = monthData.rows[0]!.month_end;
  const periodBooks = (await executor.execute<PeriodBookRow>(sql`
    select p.id as period_id, b.id as book_id
      from accounting_periods p
      join fiscal_calendars c on c.org_id = p.org_id and c.id = p.fiscal_calendar_id
      join accounting_books b on b.org_id = p.org_id and b.is_primary and b.is_active and b.posts_gl
     where p.org_id = ${orgId} and c.is_default and c.is_active and not p.is_adjustment
       and p.starts_on <= ${monthEnd}::date and p.ends_on >= ${month}::date
     order by p.id, b.id
  `)).rows;
  const periodIds = [...new Set(periodBooks.map((row) => row.period_id))];
  for (const pair of periodBooks) {
    const open = await arePeriodModulesOpen(executor, {
      orgId,
      periodId: pair.period_id,
      bookId: pair.book_id,
      subsidiaryIds,
      modules: ["ar"],
    });
    if (!open) return { open: false, periodIds };
  }
  return { open: true, periodIds };
}

async function readSources(
  executor: SqlExecutor,
  orgId: string,
  month: string,
): Promise<{
  monthEnd: string;
  previousMonth: string;
  baseCurrency: string;
  definitions: SaasMetricsDefinitions;
  subsidiaries: SubsidiaryRow[];
  subscriptions: SubscriptionSource[];
  history: HistoryRow[];
  revenueRecognitionEnabled: boolean;
  revenueRows: RevenueRow[];
  deferredRows: DeferredRow[];
  ledgerRows: LedgerFactRow[];
  billingRows: BillingRow[];
  cohortStartRows: Array<{ subsidiary_id: string; cohort_month: string; start_mrr: string; start_customers: number }>;
}> {
  const bounds = await executor.execute<{ month_end: string; previous_month: string }>(sql`
    select (${month}::date + interval '1 month - 1 day')::date::text as month_end,
           (${month}::date - interval '1 month')::date::text as previous_month
  `);
  const monthEnd = bounds.rows[0]!.month_end;
  const previousMonth = bounds.rows[0]!.previous_month;
  const org = (await executor.execute<{ base_currency: string; settings: unknown }>(sql`
    select base_currency, settings from orgs where id = ${orgId}
  `)).rows[0];
  if (!org) throw refusal("saas_metrics_org_missing", "The organization no longer exists.", "Select an active organization and run the metrics recompute again.");
  const definitions = saasMetricsDefinitions(orgId, org.settings);
  const subsidiaries = (await executor.execute<SubsidiaryRow>(sql`
    select id from subsidiaries where org_id = ${orgId} and is_active and not is_elimination order by id
  `)).rows;
  const subscriptions = (await executor.execute<SubscriptionSource>(sql`
    select s.id, s.customer_id,
           (select trusted.id from subsidiaries trusted
             where trusted.org_id = s.org_id and trusted.id = c.subsidiary_id and trusted.is_active) as trusted_subsidiary_id,
           c.subsidiary_id as customer_subsidiary_id,
           (select root.id from subsidiaries root where root.org_id = s.org_id and root.parent_id is null) as root_subsidiary_id,
           s.status, s.start_on::text, s.canceled_on::text, s.paused_on::text, s.resume_on::text,
           s.price_override::text, p.amount::text as plan_amount,
           coalesce(pv.interval, p.interval) as interval,
           coalesce(pv.interval_count, p.interval_count) as interval_count,
           s.quantity::text, coalesce(pv.currency_code, p.currency_code) as plan_currency,
           lifecycle.renewal_term_months,
           lifecycle.term_starts_on::text, lifecycle.term_ends_on::text
      from subscriptions s
      join subscription_plans p on p.org_id = s.org_id and p.id = s.plan_id
      join parties c on c.org_id = s.org_id and c.id = s.customer_id
      left join subscription_lifecycles lifecycle on lifecycle.org_id = s.org_id and lifecycle.subscription_id = s.id
      left join subscription_plan_versions pv on pv.org_id = lifecycle.org_id and pv.id = lifecycle.plan_version_id
     where s.org_id = ${orgId} and s.start_on <= ${monthEnd}::date
     order by s.id
  `)).rows;
  const subscriptionIds = subscriptions.map((row) => row.id);
  let history: HistoryRow[] = [];
  if (subscriptionIds.length > 0) {
    history = (await executor.execute<HistoryRow>(sql`
      select subscription_id, customer_id, subsidiary_id, month::text, cohort_month::text, mrr_end::text
        from saas_metrics_monthly
       where org_id = ${orgId} and month < ${month}::date
         and subscription_id in (${sql.join(subscriptionIds.map((id) => sql`${id}::uuid`), sql`, `)})
       order by subscription_id, month
    `)).rows;
  }
  const revenueRecognitionEnabled = await orgFeatureEnabled(orgId, "revenueRecognition", executor);
  const revenueRows = (await executor.execute<RevenueRow>(sql`
    with source_documents as (
      select d.id, d.posted_entry_id, d.reversal_entry_id, s.id as subscription_id
        from documents d
        join subscriptions s on s.org_id = d.org_id
         and (d.subscription_id = s.id or d.custom->>'subscriptionId' = s.id::text)
       where d.org_id = ${orgId} and d.kind in ('customer_invoice', 'customer_credit')
         and d.status in ('posted', 'voided')
    ), entries as (
      select subscription_id, posted_entry_id as entry_id from source_documents
       where posted_entry_id is not null
      union
      select subscription_id, reversal_entry_id from source_documents
       where reversal_entry_id is not null
      ${revenueRecognitionEnabled ? sql`union
      select s.id as subscription_id, posted.entry_id
        from subscriptions s
        join documents d on d.org_id = s.org_id and (d.subscription_id = s.id or d.custom->>'subscriptionId' = s.id::text)
        join document_lines dl on dl.org_id = d.org_id and dl.document_id = d.id
        join performance_obligations po on po.org_id = dl.org_id and po.document_line_id = dl.id
        join recognition_schedules rs on rs.org_id = po.org_id and rs.obligation_id = po.id
        join recognition_schedule_lines rsl on rsl.org_id = rs.org_id and rsl.schedule_id = rs.id
        cross join lateral (values (rsl.journal_entry_id), (rsl.reversal_journal_entry_id)) posted(entry_id)
       where s.org_id = ${orgId} and d.kind in ('customer_invoice', 'customer_credit')
         and d.status in ('posted', 'voided') and posted.entry_id is not null` : sql``}
    )
    select e.subscription_id, coalesce(sum(-l.amount) filter (where a.type in ('income', 'income_other')), 0)::text as revenue
      from entries e
      join journal_entries je on je.org_id = ${orgId} and je.id = e.entry_id and je.status in ('posted', 'reversed')
      join accounting_books b on b.org_id = je.org_id and b.id = je.book_id and b.is_primary and b.is_active and b.posts_gl
      join journal_lines l on l.org_id = je.org_id and l.entry_id = je.id
      join accounts a on a.org_id = l.org_id and a.id = l.account_id
     where je.posting_date >= ${month}::date
       and je.posting_date < (${month}::date + interval '1 month')
     group by e.subscription_id
  `)).rows;
  const deferredRows = (await executor.execute<DeferredRow>(sql`
    with subscription_obligations as (
      select distinct s.id as subscription_id, po.id as obligation_id,
             coalesce(po.deferred_account_id, rr.deferred_account_id) as deferred_account_id
        from subscriptions s
        join documents d on d.org_id = s.org_id and (d.subscription_id = s.id or d.custom->>'subscriptionId' = s.id::text)
        join document_lines dl on dl.org_id = d.org_id and dl.document_id = d.id
        join performance_obligations po on po.org_id = dl.org_id and po.document_line_id = dl.id
        join recognition_rules rr on rr.org_id = po.org_id and rr.id = po.recognition_rule_id
       where s.org_id = ${orgId} and d.kind in ('customer_invoice', 'customer_credit')
         and d.status in ('posted', 'voided') and coalesce(po.deferred_account_id, rr.deferred_account_id) is not null
    ), entries as (
      select distinct so.subscription_id, so.deferred_account_id, d.posted_entry_id as entry_id
        from subscription_obligations so
        join documents d on d.org_id = ${orgId}
        join document_lines dl on dl.org_id = d.org_id and dl.document_id = d.id
        join performance_obligations po on po.org_id = dl.org_id and po.id = so.obligation_id and po.document_line_id = dl.id
       where (d.subscription_id = so.subscription_id or d.custom->>'subscriptionId' = so.subscription_id::text)
         and d.status in ('posted', 'voided')
         and d.posted_entry_id is not null
      union
      select so.subscription_id, so.deferred_account_id, d.reversal_entry_id
        from subscription_obligations so
        join documents d on d.org_id = ${orgId}
        join document_lines dl on dl.org_id = d.org_id and dl.document_id = d.id
        join performance_obligations po on po.org_id = dl.org_id and po.id = so.obligation_id and po.document_line_id = dl.id
       where (d.subscription_id = so.subscription_id or d.custom->>'subscriptionId' = so.subscription_id::text)
         and d.status in ('posted', 'voided')
         and d.reversal_entry_id is not null
      union
      select so.subscription_id, so.deferred_account_id, posted.entry_id
        from subscription_obligations so
        join recognition_schedules rs on rs.org_id = ${orgId} and rs.obligation_id = so.obligation_id
        join recognition_schedule_lines rsl on rsl.org_id = rs.org_id and rsl.schedule_id = rs.id
        cross join lateral (values (rsl.journal_entry_id), (rsl.reversal_journal_entry_id)) posted(entry_id)
       where posted.entry_id is not null
    )
    select e.subscription_id,
           coalesce(sum(-l.amount) filter (where je.posting_date >= ${month}::date and je.posting_date < (${month}::date + interval '1 month')), 0)::text as deferred_delta,
           coalesce(sum(-l.amount) filter (where je.posting_date < (${month}::date + interval '1 month')), 0)::text as deferred_balance
      from entries e
      join journal_entries je on je.org_id = ${orgId} and je.id = e.entry_id and je.status in ('posted', 'reversed')
      join accounting_books b on b.org_id = je.org_id and b.id = je.book_id and b.is_primary and b.is_active and b.posts_gl
      join journal_lines l on l.org_id = je.org_id and l.entry_id = je.id and l.account_id = e.deferred_account_id
     where je.posting_date < (${month}::date + interval '1 month')
     group by e.subscription_id
  `)).rows;
  const ledgerRows = (await executor.execute<LedgerFactRow>(sql`
    select l.subsidiary_id,
           coalesce(sum(-l.amount) filter (where a.type in ('income', 'income_other')), 0)::text as revenue,
           coalesce(sum(l.amount) filter (where a.type = 'cogs'), 0)::text as cogs
      from journal_entries e
      join accounting_books b on b.org_id = e.org_id and b.id = e.book_id and b.is_primary and b.is_active and b.posts_gl
      join journal_lines l on l.org_id = e.org_id and l.entry_id = e.id
      join accounts a on a.org_id = l.org_id and a.id = l.account_id
     where e.org_id = ${orgId} and e.status in ('posted', 'reversed')
       and e.posting_date >= ${month}::date and e.posting_date < (${month}::date + interval '1 month')
     group by l.subsidiary_id
  `)).rows;
  const billingsBaseAmount = definitions.billingsUsePreTaxSubtotal ? sql`d.subtotal` : sql`d.total`;
  const billingsAmount = definitions.customerCreditsReduceBillings
    ? sql`case when d.kind = 'customer_credit' then -${billingsBaseAmount} else ${billingsBaseAmount} end`
    : billingsBaseAmount;
  const billingRows = (await executor.execute<BillingRow>(sql`
    with billing_entries as (
      select d.org_id, d.subsidiary_id, d.document_date as effective_date, ${billingsAmount} as amount
        from documents d
       where d.org_id = ${orgId} and d.kind in ('customer_invoice', 'customer_credit')
         and d.status in ('posted', 'voided') and d.posted_entry_id is not null
      union all
      select d.org_id, d.subsidiary_id, reversal.posting_date as effective_date, -(${billingsAmount}) as amount
        from documents d
        join journal_entries reversal
          on reversal.org_id = d.org_id and reversal.id = d.reversal_entry_id
         and reversal.status in ('posted', 'reversed')
       where d.org_id = ${orgId} and d.kind in ('customer_invoice', 'customer_credit')
         and d.status = 'voided' and d.posted_entry_id is not null
    )
    select coalesce(billing.subsidiary_id, (select id from subsidiaries where org_id = billing.org_id and parent_id is null)) as subsidiary_id,
           coalesce(sum(billing.amount), 0)::text as billings
      from billing_entries billing
     where billing.effective_date >= ${month}::date
       and billing.effective_date < (${month}::date + interval '1 month')
     group by 1
  `)).rows;
  const cohortStartRows = (await executor.execute<{
    subsidiary_id: string;
    cohort_month: string;
    start_mrr: string;
    start_customers: number;
  }>(sql`
    select subsidiary_id, cohort_month::text, start_mrr::text, start_customers
      from saas_metrics_cohort_monthly
     where org_id = ${orgId} and month = cohort_month and cohort_month <= ${month}::date
  `)).rows;
  return {
    monthEnd,
    previousMonth,
    baseCurrency: org.base_currency,
    definitions,
    subsidiaries,
    subscriptions,
    history,
    revenueRecognitionEnabled,
    revenueRows,
    deferredRows,
    ledgerRows,
    billingRows,
    cohortStartRows,
  };
}

function mapHistory(history: HistoryRow[]) {
  const bySubscription = new Map<string, HistoryRow[]>();
  for (const row of history) bySubscription.set(row.subscription_id, [...(bySubscription.get(row.subscription_id) ?? []), row]);
  return bySubscription;
}

async function computeRows(
  executor: SqlExecutor,
  orgId: string,
  month: string,
  sources: Awaited<ReturnType<typeof readSources>>,
): Promise<{ rows: MonthlySubscriptionFact[]; rates: Record<string, string> }> {
  const historyBySubscription = mapHistory(sources.history);
  const revenueBySubscription = new Map(sources.revenueRows.map((row) => [row.subscription_id, row.revenue]));
  const deferredBySubscription = new Map(sources.deferredRows.map((row) => [row.subscription_id, row]));
  const rates: Record<string, string> = {};
  const monthEnd = sources.monthEnd;
  const previousMonthStart = sources.previousMonth;
  const previousBounds = await executor.execute<{ previous_month_end: string }>(sql`
    select (${previousMonthStart}::date + interval '1 month - 1 day')::date::text as previous_month_end
  `);
  const previousMonthEnd = previousBounds.rows[0]!.previous_month_end;
  const rows: MonthlySubscriptionFact[] = [];
  for (const source of sources.subscriptions) {
    if (source.customer_subsidiary_id !== null && source.trusted_subsidiary_id === null) {
      throw refusal(
        "saas_metrics_billing_subsidiary_invalid",
        `Subscription ${source.id} belongs to a customer assigned to an inactive subsidiary.`,
        "Reassign the customer to an active subsidiary, or clear its subsidiary assignment for an organization-wide customer, then recompute the month.",
        { field: "customer.subsidiary_id" },
      );
    }
    const subsidiaryId = source.trusted_subsidiary_id ?? source.root_subsidiary_id;
    if (!subsidiaryId) {
      throw refusal(
        "saas_metrics_billing_subsidiary_missing",
        `Subscription ${source.id} cannot resolve its billing subsidiary.`,
        "Assign the customer to an active subsidiary or restore the organization's root subsidiary, then recompute the month.",
        { field: "customer.subsidiary_id" },
      );
    }
    const sourceCurrency = (source.plan_currency ?? sources.baseCurrency).trim().toUpperCase();
    const monthStatus = statusAtMonthEnd(source, monthEnd);
    const normalized = () => monthlyRecurringRevenue(
      source.price_override ?? source.plan_amount,
      source.interval,
      source.interval_count,
      source.quantity,
    );
    const rateOn = async (date: string): Promise<string> => {
      const key = `${sourceCurrency}:${date}`;
      if (!rates[key]) rates[key] = await spotRate(executor, orgId, sourceCurrency, sources.baseCurrency, date);
      return rates[key]!;
    };
    const mrrEnd = monthStatus === "active"
      ? mulDecimal(normalized(), await rateOn(monthEnd))
      : "0.0000";
    const history = historyBySubscription.get(source.id) ?? [];
    const priorMonth = history.find((row) => row.month.slice(0, 10) === previousMonthStart);
    const previousStatus = statusAtMonthEnd(source, previousMonthEnd);
    let mrrStart = priorMonth?.mrr_end ?? "0.0000";
    if (!priorMonth && source.start_on <= previousMonthEnd && previousStatus === "active") {
      mrrStart = mulDecimal(normalized(), await rateOn(previousMonthEnd));
    }
    const movement = chooseMovement({
      mrrStart,
      mrrEnd,
      previousMonthRecorded: priorMonth !== undefined,
      priorPositive: history.some((row) => cmp(row.mrr_end, "0") > 0)
        || (source.start_on <= previousMonthEnd && previousStatus !== "active" && monthStatus === "active"),
    });
    const amounts = movementAmounts(movement, mrrStart, mrrEnd);
    const identity = add(
      add(add(amounts.newMrr, amounts.expansionMrr), amounts.reactivationMrr),
      neg(add(add(amounts.contractionMrr, amounts.churnedMrr), "0.0000")),
    );
    if (cmp(identity, add(mrrEnd, neg(mrrStart))) !== 0) {
      throw refusal(
        "saas_metrics_movement_identity_invalid",
        `The computed ${movement} movement for subscription ${source.id} does not reconcile to its opening and closing MRR.`,
        "Correct the subscription price, quantity, status, or dated FX rate and recompute the month.",
      );
    }
    const rawTermMonths = source.renewal_term_months == null
      ? source.term_starts_on && source.term_ends_on
        ? String(Math.max(1, monthOrdinal(monthStartForDate(source.term_ends_on)) - monthOrdinal(monthStartForDate(source.term_starts_on)) + 1))
        : sources.definitions.evergreenBookingMonths
      : String(source.renewal_term_months);
    const bookedRecurring = movement === "new" || movement === "reactivation"
      ? mrrEnd
      : movement === "expansion"
        ? amounts.expansionMrr
        : "0.0000";
    rows.push({
      orgId,
      subsidiaryId,
      customerId: source.customer_id,
      subscriptionId: source.id,
      month,
      cohortMonth: monthStartForDate(source.start_on),
      mrrStart,
      mrrEnd,
      ...amounts,
      movement,
      recognizedRevenue: revenueBySubscription.get(source.id) ?? "0.0000",
      deferredDelta: deferredBySubscription.get(source.id)?.deferred_delta ?? "0.0000",
      booking: mul(bookedRecurring, rawTermMonths),
    });
  }
  return { rows, rates };
}

type FactsRow = {
  subsidiaryId: string;
  month: string;
  mrrStart: string;
  mrrEnd: string;
  newMrr: string;
  expansionMrr: string;
  contractionMrr: string;
  churnedMrr: string;
  reactivationMrr: string;
  recognizedRevenue: string;
  deferredDelta: string;
  mrrAtRisk: string;
  customersStart: number;
  customersEnd: number;
  customersNew: number;
  customersChurned: number;
  customersReactivated: number;
  glRevenue: string;
  glCogs: string;
  bookings: string;
  billings: string;
  deferredBalance: string;
  basis: "recognised" | "billed";
};

function aggregateFacts(
  month: string,
  subsidiaryIds: string[],
  rows: MonthlySubscriptionFact[],
  history: HistoryRow[],
  ledgerRows: LedgerFactRow[],
  billingRows: BillingRow[],
  deferredRows: DeferredRow[],
  basis: FactsRow["basis"],
): FactsRow[] {
  const historyLive = new Set(history.filter((row) => cmp(row.mrr_end, "0") > 0).map((row) => `${row.subsidiary_id}:${row.customer_id}`));
  const facts: FactsRow[] = [];
  for (const subsidiaryId of subsidiaryIds) {
    const scoped = rows.filter((row) => row.subsidiaryId === subsidiaryId);
    const customersStart = new Set(scoped.filter((row) => cmp(row.mrrStart, "0") > 0).map((row) => row.customerId));
    const customersEnd = new Set(scoped.filter((row) => cmp(row.mrrEnd, "0") > 0).map((row) => row.customerId));
    const allCustomerIds = new Set(scoped.map((row) => row.customerId));
    let customersNew = 0;
    let customersChurned = 0;
    let customersReactivated = 0;
    for (const customerId of allCustomerIds) {
      const wasActive = customersStart.has(customerId);
      const isActive = customersEnd.has(customerId);
      const existed = historyLive.has(`${subsidiaryId}:${customerId}`);
      if (isActive && !wasActive && !existed) customersNew += 1;
      if (wasActive && !isActive) customersChurned += 1;
      if (isActive && !wasActive && existed) customersReactivated += 1;
    }
    facts.push({
      subsidiaryId,
      month,
      mrrStart: moneySum(scoped.map((row) => row.mrrStart)),
      mrrEnd: moneySum(scoped.map((row) => row.mrrEnd)),
      newMrr: moneySum(scoped.map((row) => row.newMrr)),
      expansionMrr: moneySum(scoped.map((row) => row.expansionMrr)),
      contractionMrr: moneySum(scoped.map((row) => row.contractionMrr)),
      churnedMrr: moneySum(scoped.map((row) => row.churnedMrr)),
      reactivationMrr: moneySum(scoped.map((row) => row.reactivationMrr)),
      recognizedRevenue: moneySum(scoped.map((row) => row.recognizedRevenue)),
      deferredDelta: moneySum(scoped.map((row) => row.deferredDelta)),
      mrrAtRisk: moneySum(scoped.map((row) => row.mrrStart)),
      customersStart: customersStart.size,
      customersEnd: customersEnd.size,
      customersNew,
      customersChurned,
      customersReactivated,
      glRevenue: ledgerRows.find((row) => row.subsidiary_id === subsidiaryId)?.revenue ?? "0.0000",
      glCogs: ledgerRows.find((row) => row.subsidiary_id === subsidiaryId)?.cogs ?? "0.0000",
      bookings: moneySum(scoped.map((row) => row.booking)),
      billings: billingRows.find((row) => row.subsidiary_id === subsidiaryId)?.billings ?? "0.0000",
      deferredBalance: moneySum(scoped.map((row) => deferredRows.find((r) => r.subscription_id === row.subscriptionId)?.deferred_balance ?? "0.0000")),
      basis,
    });
  }
  return facts;
}

function aggregateCohorts(
  month: string,
  rows: MonthlySubscriptionFact[],
  history: HistoryRow[],
  cohortStarts: Awaited<ReturnType<typeof readSources>>["cohortStartRows"],
): Array<{
  subsidiaryId: string;
  cohortMonth: string;
  month: string;
  monthsSinceStart: number;
  startMrr: string;
  mrr: string;
  startCustomers: number;
  customers: number;
}> {
  const groups = new Map<string, MonthlySubscriptionFact[]>();
  for (const row of rows) {
    const key = `${row.subsidiaryId}:${row.cohortMonth}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, cohortRows]) => {
    const separator = key.indexOf(":");
    const subsidiaryId = key.slice(0, separator);
    const cohortMonth = key.slice(separator + 1);
    const storedStart = cohortStarts.find((row) => row.subsidiary_id === subsidiaryId && row.cohort_month.slice(0, 10) === cohortMonth);
    const historicalStartRows = history.filter((row) =>
      row.subsidiary_id === subsidiaryId
      && row.month.slice(0, 10) === cohortMonth
      && row.cohort_month.slice(0, 10) === cohortMonth
    );
    const startMrr = storedStart?.start_mrr
      ?? (cohortMonth === month
        ? moneySum(cohortRows.map((row) => row.mrrEnd))
        : moneySum(historicalStartRows.map((row) => row.mrr_end)));
    const startCustomers = storedStart?.start_customers
      ?? new Set((cohortMonth === month
        ? cohortRows.filter((row) => cmp(row.mrrEnd, "0") > 0).map((row) => row.customerId)
        : historicalStartRows.filter((row) => cmp(row.mrr_end, "0") > 0).map((row) => row.customer_id))).size;
    if (cohortMonth < month && historicalStartRows.length === 0 && storedStart === undefined) {
      throw refusal(
        "saas_metrics_cohort_start_missing",
        `The opening month ${cohortMonth} for SaaS cohort ${cohortMonth} in subsidiary ${subsidiaryId} has not been computed.`,
        `Recompute the cohort's opening month ${cohortMonth} before recomputing ${month}.`,
      );
    }
    return {
      subsidiaryId,
      cohortMonth,
      month,
      monthsSinceStart: monthOrdinal(month) - monthOrdinal(cohortMonth),
      startMrr,
      mrr: moneySum(cohortRows.map((row) => row.mrrEnd)),
      startCustomers,
      customers: new Set(cohortRows.filter((row) => cmp(row.mrrEnd, "0") > 0).map((row) => row.customerId)).size,
    };
  });
}

async function writeMonthlyRow(
  executor: SqlExecutor,
  row: MonthlySubscriptionFact,
  inputsHash: string,
): Promise<void> {
  const result = await executor.execute<{ id: string }>(sql`
    insert into saas_metrics_monthly
      (org_id, subsidiary_id, customer_id, subscription_id, month, cohort_month,
       mrr_start, mrr_end, new_mrr, expansion_mrr, contraction_mrr, churned_mrr,
       reactivation_mrr, movement, recognized_revenue, deferred_delta, inputs_hash, computed_at)
    values
      (${row.orgId}, ${row.subsidiaryId}, ${row.customerId}, ${row.subscriptionId}, ${row.month}::date,
       ${row.cohortMonth}::date, ${row.mrrStart}, ${row.mrrEnd}, ${row.newMrr}, ${row.expansionMrr},
       ${row.contractionMrr}, ${row.churnedMrr}, ${row.reactivationMrr}, ${row.movement},
       ${row.recognizedRevenue}, ${row.deferredDelta}, ${inputsHash}, now())
    on conflict (org_id, month, subscription_id) do update set
      subsidiary_id = excluded.subsidiary_id, customer_id = excluded.customer_id,
      cohort_month = excluded.cohort_month, mrr_start = excluded.mrr_start, mrr_end = excluded.mrr_end,
      new_mrr = excluded.new_mrr, expansion_mrr = excluded.expansion_mrr,
      contraction_mrr = excluded.contraction_mrr, churned_mrr = excluded.churned_mrr,
      reactivation_mrr = excluded.reactivation_mrr, movement = excluded.movement,
      recognized_revenue = excluded.recognized_revenue, deferred_delta = excluded.deferred_delta,
      inputs_hash = excluded.inputs_hash, computed_at = excluded.computed_at
    returning id
  `);
  if (result.rows.length !== 1) throw refusal("saas_metrics_subscription_write_missing", `Metrics for subscription ${row.subscriptionId} were not stored.`, "Retry the recompute after confirming that the subscription remains in the organization.");
}

async function writeFactsRow(
  executor: SqlExecutor,
  orgId: string,
  row: FactsRow,
  inputsHash: string,
): Promise<void> {
  const result = await executor.execute<{ id: string }>(sql`
    insert into saas_metrics_facts_monthly
      (org_id, subsidiary_id, month, mrr_start, mrr_end, new_mrr, expansion_mrr,
       contraction_mrr, churned_mrr, reactivation_mrr, recognized_revenue, deferred_delta,
       mrr_at_risk, customers_start,
       customers_end, customers_new, customers_churned, customers_reactivated,
       gl_revenue, gl_cogs, bookings, billings, deferred_balance, basis, inputs_hash, computed_at)
    values
      (${orgId}, ${row.subsidiaryId}, ${row.month}::date, ${row.mrrStart}, ${row.mrrEnd},
       ${row.newMrr}, ${row.expansionMrr}, ${row.contractionMrr}, ${row.churnedMrr},
       ${row.reactivationMrr}, ${row.recognizedRevenue}, ${row.deferredDelta}, ${row.mrrAtRisk},
       ${row.customersStart}, ${row.customersEnd},
       ${row.customersNew}, ${row.customersChurned}, ${row.customersReactivated},
       ${row.glRevenue}, ${row.glCogs}, ${row.bookings}, ${row.billings}, ${row.deferredBalance},
       ${row.basis}, ${inputsHash}, now())
    on conflict (org_id, subsidiary_id, month) do update set
      mrr_start = excluded.mrr_start, mrr_end = excluded.mrr_end, new_mrr = excluded.new_mrr,
      expansion_mrr = excluded.expansion_mrr, contraction_mrr = excluded.contraction_mrr,
      churned_mrr = excluded.churned_mrr, reactivation_mrr = excluded.reactivation_mrr,
      recognized_revenue = excluded.recognized_revenue, deferred_delta = excluded.deferred_delta,
      mrr_at_risk = excluded.mrr_at_risk, customers_start = excluded.customers_start,
      customers_end = excluded.customers_end, customers_new = excluded.customers_new,
      customers_churned = excluded.customers_churned, customers_reactivated = excluded.customers_reactivated,
      gl_revenue = excluded.gl_revenue, gl_cogs = excluded.gl_cogs, bookings = excluded.bookings,
      billings = excluded.billings, deferred_balance = excluded.deferred_balance, basis = excluded.basis,
      inputs_hash = excluded.inputs_hash, computed_at = excluded.computed_at
    returning id
  `);
  if (result.rows.length !== 1) throw refusal("saas_metrics_facts_write_missing", `Monthly facts for subsidiary ${row.subsidiaryId} were not stored.`, "Retry the recompute after confirming that the subsidiary remains active.");
}

async function writeCohortRow(
  executor: SqlExecutor,
  orgId: string,
  row: ReturnType<typeof aggregateCohorts>[number],
  inputsHash: string,
): Promise<void> {
  const result = await executor.execute<{ id: string }>(sql`
    insert into saas_metrics_cohort_monthly
      (org_id, subsidiary_id, cohort_month, month, months_since_start, start_mrr, mrr,
       start_customers, customers, inputs_hash, computed_at)
    values (${orgId}, ${row.subsidiaryId}, ${row.cohortMonth}::date, ${row.month}::date,
            ${row.monthsSinceStart}, ${row.startMrr}, ${row.mrr}, ${row.startCustomers},
            ${row.customers}, ${inputsHash}, now())
    on conflict (org_id, subsidiary_id, cohort_month, month) do update set
      months_since_start = excluded.months_since_start, start_mrr = excluded.start_mrr,
      mrr = excluded.mrr, start_customers = excluded.start_customers, customers = excluded.customers,
      inputs_hash = excluded.inputs_hash, computed_at = excluded.computed_at
    returning id
  `);
  if (result.rows.length !== 1) throw refusal("saas_metrics_cohort_write_missing", `Cohort facts for subsidiary ${row.subsidiaryId} and cohort ${row.cohortMonth} were not stored.`, "Retry the recompute after confirming that the cohort remains in the organization.");
}

export async function recomputeSaasMetrics(
  orgId: string,
  month: string,
): Promise<SaasMetricsRecomputeResult> {
  if (!/^\d{4}-\d{2}-01$/.test(month)) {
    throw refusal("saas_metrics_month_invalid", `Metrics month "${month}" must be the first day of a calendar month.`, "Supply the month as YYYY-MM-01.", { field: "month" });
  }
  return withOrgTransaction(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "saasMetrics"))) {
      throw refusal("feature_off", "SaaS metrics are disabled for this organization.", FEATURES_REMEDY);
    }
    const sources = await readSources(db, orgId, month);
    const computed = await computeRows(db, orgId, month, sources);
    const basis: FactsRow["basis"] = sources.revenueRecognitionEnabled ? "recognised" : "billed";
    const revenueBySubscription = new Map(sources.revenueRows.map((row) => [row.subscription_id, row.revenue]));
    for (const row of computed.rows) {
      row.recognizedRevenue = revenueBySubscription.get(row.subscriptionId) ?? "0.0000";
    }
    const facts = aggregateFacts(
      month,
      sources.subsidiaries.map((row) => row.id),
      computed.rows,
      sources.history,
      sources.ledgerRows,
      sources.billingRows,
      sources.deferredRows,
      basis,
    );
    const cohorts = aggregateCohorts(month, computed.rows, sources.history, sources.cohortStartRows);
    const monthHash = hash({
      orgId,
      month,
      baseCurrency: sources.baseCurrency,
      revenueRecognitionEnabled: sources.revenueRecognitionEnabled,
      subscriptions: computed.rows,
      cohortStarts: sources.cohortStartRows,
      definitions: sources.definitions,
      rates: computed.rates,
      revenue: sources.revenueRows,
      deferred: sources.deferredRows,
      ledger: sources.ledgerRows,
      billings: sources.billingRows,
      subsidiaries: sources.subsidiaries,
    });
    const closeState = await monthCloseState(db, orgId, month, sources.subsidiaries.map((row) => row.id));
    const storedState = (await db.execute<{ row_count: number; changed: boolean }>(sql`
      select count(*)::int as row_count, coalesce(bool_or(inputs_hash <> ${monthHash}), false) as changed
        from (
          select inputs_hash from saas_metrics_facts_monthly where org_id = ${orgId} and month = ${month}::date
          union all
          select inputs_hash from saas_metrics_monthly where org_id = ${orgId} and month = ${month}::date
          union all
          select inputs_hash from saas_metrics_cohort_monthly where org_id = ${orgId} and month = ${month}::date
        ) stored
    `)).rows[0]!;
    if (!closeState.open && storedState.row_count > 0 && storedState.changed) {
      throw refusal(
        "saas_metrics_closed_month_changed",
        `SaaS metrics for closed AR month ${month} have changed inputs and remain frozen.`,
        CLOSED_PERIOD_REMEDY,
        { status: 409 },
      );
    }
    if (!closeState.open && storedState.row_count > 0) {
      return { orgId, month, subscriptionRows: computed.rows.length, subsidiaryRows: facts.length, frozen: true };
    }
    for (const row of computed.rows) await writeMonthlyRow(db, row, monthHash);
    for (const row of facts) await writeFactsRow(db, orgId, row, monthHash);
    for (const row of cohorts) await writeCohortRow(db, orgId, row, monthHash);
    return { orgId, month, subscriptionRows: computed.rows.length, subsidiaryRows: facts.length, frozen: !closeState.open };
  });
}

export async function saasMetricsScanTargets(): Promise<SaasMetricsScanTargets> {
  // bypass: scheduler-tick — the metrics pass lists every organization before checking each one's feature gate.
  const orgIds = await withBypassContext(async () =>
    (await db.execute<{ id: string }>(sql`select id from orgs order by id`)).rows.map((row) => row.id));
  const enabledOrgIds: string[] = [];
  const skippedFeatureOffOrgIds: string[] = [];
  for (const orgId of orgIds) {
    if (await withOrgContext(orgId, () => orgFeatureEnabled(orgId, "saasMetrics", db))) enabledOrgIds.push(orgId);
    else skippedFeatureOffOrgIds.push(orgId);
  }
  return { enabledOrgIds, skippedFeatureOffOrgIds };
}

async function monthIsOpenForAr(orgId: string, month: string): Promise<boolean> {
  return withOrgTransaction(orgId, async () => {
    const subsidiaries = (await db.execute<SubsidiaryRow>(sql`
      select id from subsidiaries where org_id = ${orgId} and is_active and not is_elimination order by id
    `)).rows;
    return (await monthCloseState(db, orgId, month, subsidiaries.map((row) => row.id))).open;
  });
}

async function monthHasStoredMetrics(orgId: string, month: string): Promise<boolean> {
  return withOrgTransaction(orgId, async () => {
    const result = await db.execute<{ has_rows: boolean }>(sql`
      select exists (
        select 1 from saas_metrics_monthly where org_id = ${orgId} and month = ${month}::date
        union all
        select 1 from saas_metrics_facts_monthly where org_id = ${orgId} and month = ${month}::date
        union all
        select 1 from saas_metrics_cohort_monthly where org_id = ${orgId} and month = ${month}::date
      ) as has_rows
    `);
    return result.rows[0]!.has_rows;
  });
}

export async function recomputeOpenSaasMetrics(orgId: string): Promise<{
  recomputed: SaasMetricsRecomputeResult[];
  skippedClosedMonths: string[];
}> {
  if (!(await orgFeatureEnabled(orgId, "saasMetrics"))) {
    throw refusal("feature_off", "SaaS metrics are disabled for this organization.", FEATURES_REMEDY);
  }
  const today = await businessToday(orgId);
  const currentMonth = monthStartForDate(today);
  const { existingMonths, firstSubscriptionMonth } = await withOrgTransaction(orgId, async () => {
    const existingMonths = (await db.execute<{ month: string }>(sql`
      select distinct month::text from saas_metrics_facts_monthly
       where org_id = ${orgId} and month <= ${currentMonth}::date order by month
    `)).rows.map((row) => row.month.slice(0, 10));
    const firstSubscriptionMonth = (await db.execute<{ month: string | null }>(sql`
      select date_trunc('month', min(start_on))::date::text as month
        from subscriptions where org_id = ${orgId}
    `)).rows[0]?.month?.slice(0, 10) ?? null;
    return { existingMonths, firstSubscriptionMonth };
  });
  const generatedMonths = firstSubscriptionMonth === null
    ? []
    : Array.from(
      { length: Math.max(0, monthOrdinal(currentMonth) - monthOrdinal(firstSubscriptionMonth) + 1) },
      (_, index) => monthFromOrdinal(monthOrdinal(firstSubscriptionMonth) + index),
    );
  const months = [...new Set([...generatedMonths, ...existingMonths, currentMonth])].sort();
  const recomputed: SaasMetricsRecomputeResult[] = [];
  const skippedClosedMonths: string[] = [];
  for (const month of months) {
    if (!(await monthIsOpenForAr(orgId, month))) {
      if (await monthHasStoredMetrics(orgId, month)) {
        skippedClosedMonths.push(month);
      } else {
        // Closed periods receive one initial derived snapshot; later scans
        // leave that frozen result alone.
        recomputed.push(await recomputeSaasMetrics(orgId, month));
      }
      continue;
    }
    recomputed.push(await recomputeSaasMetrics(orgId, month));
  }
  return { recomputed, skippedClosedMonths };
}
