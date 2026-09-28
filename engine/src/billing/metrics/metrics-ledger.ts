import { sql } from "drizzle-orm";
import {
  add,
  cmp,
  mul,
  mulDecimal,
  neg,
} from "../../money/money.ts";
import {
  averageSpotRateForMonthWithEvidence,
  lookupSpotRateWithEvidence,
  type FxAsOfEvidence,
  type FxMonthAverageEvidence,
} from "../../fx/spot-rate.ts";
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
import {
  normalizationInputsHash,
  SAAS_METRICS_DENOMINATION_VERSION,
} from "./metrics-normalization.ts";

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
  reporting_currency: string | null;
  denomination_version: string | null;
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

type RevenueBucket = {
  subscription_id: string;
  subsidiary_id: string;
  functional_currency: string;
  entry_ids: string[];
  revenue: string;
};
type DeferredBucket = {
  subscription_id: string;
  subsidiary_id: string;
  functional_currency: string;
  entry_ids: string[];
  deferred_delta: string;
  deferred_balance: string;
};
type LedgerBucket = { subsidiary_id: string; functional_currency: string; revenue: string; cogs: string };
type BillingLeg = {
  document_id: string;
  subsidiary_id: string;
  functional_currency: string;
  txn_currency: string;
  txn_amount: string;
  stored_fx_rate: string;
  leg: string;
  effective_date: string;
};
type SubsidiaryRow = { id: string; base_currency: string };
type PeriodBookRow = { period_id: string; book_id: string };

function refusal(
  code: string,
  message: string,
  remedy: string,
  options?: { field?: string | null; status?: 422 | 409 },
): UsageBillingError {
  return new UsageBillingError(code, message, remedy, options);
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

/**
 * Normalization doctrine shared by every translator below. All FX evidence
 * comes from the direct-or-inverse `fx_rates` spot readers: the authoritative
 * table is `fx_rates`, and a manual consolidated override changes
 * consolidation output, never the evidence here. `consolidated_fx_rates` is
 * never imported or read by this module.
 */
type FxEvidenceCache = {
  asOf: Map<string, FxAsOfEvidence>;
  monthAverage: Map<string, FxMonthAverageEvidence>;
};

function fxRemedy(fromCurrency: string, toCurrency: string, scope: string): string {
  return `Add the dated spot rate ${fromCurrency}→${toCurrency} ${scope} under Company Settings → Setup → FX rates, then recompute the month.`;
}

/** Current (as-of) spot with evidence; refuses by name when the pair is uncovered. */
async function asOfEvidence(
  executor: SqlExecutor,
  orgId: string,
  cache: FxEvidenceCache,
  args: { measure: string; from: string; to: string; onDate: string; field: string; context: string },
): Promise<FxAsOfEvidence> {
  const key = `${args.from}→${args.to}:${args.onDate}`;
  let evidence = cache.asOf.get(key);
  if (!evidence) {
    evidence = await lookupSpotRateWithEvidence(executor, orgId, args.from, args.to, args.onDate);
    cache.asOf.set(key, evidence);
  }
  if (evidence.rate === null) {
    throw refusal(
      "saas_metrics_fx_rate_missing",
      `No spot FX rate is available for ${args.measure} ${args.from}→${args.to} on or before ${args.onDate} (${args.context}).`,
      fxRemedy(args.from, args.to, `on or before ${args.onDate}`),
      { field: args.field },
    );
  }
  return evidence;
}

/**
 * Exact calendar-month average with evidence. The window is always the
 * calendar month the helper derives — an accounting period that starts or
 * ends mid-month never narrows or widens it. Refuses by name when the month
 * holds no dated observation; there is no closing/current fallback.
 */
async function monthAverageEvidence(
  executor: SqlExecutor,
  orgId: string,
  cache: FxEvidenceCache,
  args: { measure: string; from: string; to: string; year: number; month: number; field: string; context: string },
): Promise<FxMonthAverageEvidence> {
  const month = `${args.year}-${String(args.month).padStart(2, "0")}`;
  const key = `${args.from}→${args.to}:${month}`;
  let evidence = cache.monthAverage.get(key);
  if (!evidence) {
    evidence = await averageSpotRateForMonthWithEvidence(executor, orgId, args.from, args.to, args.year, args.month);
    cache.monthAverage.set(key, evidence);
  }
  if (evidence.rate === null) {
    throw refusal(
      "saas_metrics_fx_rate_missing",
      `No calendar-month-average FX rate is available for ${args.measure} ${args.from}→${args.to} for ${month} (${args.context}).`,
      fxRemedy(args.from, args.to, `quoted in ${month}`),
      { field: args.field },
    );
  }
  return evidence;
}

/**
 * Before any sum or write, every subscription journal source must resolve to
 * exactly one subsidiary, and that subsidiary must be the subscription's
 * trusted billing subsidiary. A source with no rows is genuinely nil and
 * stays zero; a source spread across subsidiaries, or posted under another
 * legal entity, refuses before aggregation — the grain is never redesigned
 * around a mis-attributed entry.
 */
function attributedBucket<Bucket extends { subsidiary_id: string; entry_ids: string[] }>(args: {
  measure: string;
  subscriptionId: string;
  trustedSubsidiaryId: string;
  buckets: Bucket[];
}): Bucket | null {
  if (args.buckets.length === 0) return null;
  const distinct = [...new Set(args.buckets.map((bucket) => bucket.subsidiary_id))];
  if (distinct.length !== 1 || distinct[0] !== args.trustedSubsidiaryId) {
    const entryIds = [...new Set(args.buckets.flatMap((bucket) => bucket.entry_ids))].sort();
    throw refusal(
      "saas_metrics_subscription_attribution_mismatch",
      `Subscription ${args.subscriptionId} has ${args.measure} journal lines attributed to subsidiary ${distinct.join(", ")} (entries ${entryIds.join(", ") || "none"}), but the subscription bills under subsidiary ${args.trustedSubsidiaryId}.`,
      `Reverse the mis-attributed entry and repost it under subsidiary ${args.trustedSubsidiaryId}, or reassign the subscription's billing subsidiary, then recompute the month.`,
      { field: "subsidiary_id" },
    );
  }
  return args.buckets[0]!;
}

/**
 * Every historical metrics row the writer consumes carries the denomination
 * it was stored in. A row without a reporting currency — written before
 * normalization — or under an unknown version fails closed instead of
 * silently inheriting the current org base. That includes rows consulted
 * only for sign or existence: a denomination-invariant comparison still
 * consumes the row, so legacy rows cannot bypass the rollout refusal.
 *
 * The remedy is real: recompute the source month through SaaS metrics
 * recompute — the flow that normalizes stored months to the definitions in
 * Company Settings → Setup → Company — so its rows carry v1 evidence, then
 * recompute the current month. A closed legacy month stays frozen; correct
 * it through the period-close reversal flow, never by rewriting history.
 */
function validatedHistoryCurrency(args: {
  scope: string;
  month: string;
  sourceMonth: string;
  reportingCurrency: string | null;
  denominationVersion: string | null;
}): string {
  const currency = args.reportingCurrency?.trim().toUpperCase() ?? null;
  if (currency === null || args.denominationVersion !== SAAS_METRICS_DENOMINATION_VERSION) {
    const stored = args.denominationVersion ?? "absent";
    throw refusal(
      "saas_metrics_history_denomination_unknown",
      `${args.scope} is stored without normalized denomination evidence (reporting currency ${currency ?? "absent"}, denomination ${stored}) and cannot open ${args.month}.`,
      `Recompute ${args.sourceMonth} through SaaS metrics recompute — the flow that normalizes stored months to the definitions in Company Settings → Setup → Company — so its rows carry v1 evidence, then recompute ${args.month}. A closed legacy month stays frozen; correct it through the period-close reversal flow, never by rewriting history.`,
      { field: "month" },
    );
  }
  return currency;
}

/** Calendar month-end for a month start, for cohort-opening translation. */
async function monthEndFor(executor: SqlExecutor, monthStart: string): Promise<string> {
  const bounds = await executor.execute<{ month_end: string }>(sql`
    select (${monthStart}::date + interval '1 month - 1 day')::date::text as month_end
  `);
  return bounds.rows[0]!.month_end;
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
  revenueBuckets: RevenueBucket[];
  deferredBuckets: DeferredBucket[];
  ledgerBuckets: LedgerBucket[];
  billingLegs: BillingLeg[];
  cohortStartRows: Array<{
    subsidiary_id: string;
    cohort_month: string;
    start_mrr: string;
    start_customers: number;
    reporting_currency: string | null;
    denomination_version: string | null;
  }>;
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
    select id, base_currency from subsidiaries where org_id = ${orgId} and is_active and not is_elimination order by id
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
      select subscription_id, customer_id, subsidiary_id, month::text, cohort_month::text, mrr_end::text,
             reporting_currency, denomination_version
        from saas_metrics_monthly
       where org_id = ${orgId} and month < ${month}::date
         and subscription_id in (${sql.join(subscriptionIds.map((id) => sql`${id}::uuid`), sql`, `)})
       order by subscription_id, month
    `)).rows;
  }
  const revenueRecognitionEnabled = await orgFeatureEnabled(orgId, "revenueRecognition", executor);
  // Journal amounts below are subsidiary-functional, never org-base: each
  // bucket keeps its functional currency so translation happens per legal
  // entity against month evidence, before any sum.
  const revenueBuckets = (await executor.execute<RevenueBucket>(sql`
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
    select e.subscription_id, l.subsidiary_id, sub.base_currency as functional_currency,
           array_agg(distinct e.entry_id::text order by e.entry_id::text) as entry_ids,
           coalesce(sum(-l.amount) filter (where a.type in ('income', 'income_other')), 0)::text as revenue
      from entries e
      join journal_entries je on je.org_id = ${orgId} and je.id = e.entry_id and je.status in ('posted', 'reversed')
      join accounting_books b on b.org_id = je.org_id and b.id = je.book_id and b.is_primary and b.is_active and b.posts_gl
      join journal_lines l on l.org_id = je.org_id and l.entry_id = je.id
      join accounts a on a.org_id = l.org_id and a.id = l.account_id
      join subsidiaries sub on sub.org_id = je.org_id and sub.id = l.subsidiary_id
     where je.posting_date >= ${month}::date
       and je.posting_date < (${month}::date + interval '1 month')
     group by e.subscription_id, l.subsidiary_id, sub.base_currency
     order by e.subscription_id, l.subsidiary_id
  `)).rows;
  const deferredBuckets = (await executor.execute<DeferredBucket>(sql`
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
    select e.subscription_id, l.subsidiary_id, sub.base_currency as functional_currency,
           array_agg(distinct e.entry_id::text order by e.entry_id::text) as entry_ids,
           coalesce(sum(-l.amount) filter (where je.posting_date >= ${month}::date and je.posting_date < (${month}::date + interval '1 month')), 0)::text as deferred_delta,
           coalesce(sum(-l.amount) filter (where je.posting_date < (${month}::date + interval '1 month')), 0)::text as deferred_balance
      from entries e
      join journal_entries je on je.org_id = ${orgId} and je.id = e.entry_id and je.status in ('posted', 'reversed')
      join accounting_books b on b.org_id = je.org_id and b.id = je.book_id and b.is_primary and b.is_active and b.posts_gl
      join journal_lines l on l.org_id = je.org_id and l.entry_id = je.id and l.account_id = e.deferred_account_id
      join subsidiaries sub on sub.org_id = je.org_id and sub.id = l.subsidiary_id
     where je.posting_date < (${month}::date + interval '1 month')
     group by e.subscription_id, l.subsidiary_id, sub.base_currency
     order by e.subscription_id, l.subsidiary_id
  `)).rows;
  const ledgerBuckets = (await executor.execute<LedgerBucket>(sql`
    select l.subsidiary_id, sub.base_currency as functional_currency,
           coalesce(sum(-l.amount) filter (where a.type in ('income', 'income_other')), 0)::text as revenue,
           coalesce(sum(l.amount) filter (where a.type = 'cogs'), 0)::text as cogs
      from journal_entries e
      join accounting_books b on b.org_id = e.org_id and b.id = e.book_id and b.is_primary and b.is_active and b.posts_gl
      join journal_lines l on l.org_id = e.org_id and l.entry_id = e.id
      join accounts a on a.org_id = l.org_id and a.id = l.account_id
      join subsidiaries sub on sub.org_id = e.org_id and sub.id = l.subsidiary_id
     where e.org_id = ${orgId} and e.status in ('posted', 'reversed')
       and e.posting_date >= ${month}::date and e.posting_date < (${month}::date + interval '1 month')
     group by l.subsidiary_id, sub.base_currency
     order by l.subsidiary_id
  `)).rows;
  const billingsBaseAmount = definitions.billingsUsePreTaxSubtotal ? sql`d.subtotal` : sql`d.total`;
  const billingsAmount = definitions.customerCreditsReduceBillings
    ? sql`case when d.kind = 'customer_credit' then -${billingsBaseAmount} else ${billingsBaseAmount} end`
    : billingsBaseAmount;
  // Billings stay at per-leg grain: one row per posted/reversal document leg,
  // carrying the document's stored posting FX. Translation multiplies each
  // leg through its own stored rate first, so distinct document rates are
  // never grouped away before conversion.
  const billingLegs = (await executor.execute<BillingLeg>(sql`
    with billing_legs as (
      select d.id as document_id, d.org_id, d.subsidiary_id, d.currency as txn_currency,
             d.fx_rate::text as stored_fx_rate, ${billingsAmount} as txn_amount,
             d.document_date as effective_date, 'posted' as leg
        from documents d
       where d.org_id = ${orgId} and d.kind in ('customer_invoice', 'customer_credit')
         and d.status in ('posted', 'voided') and d.posted_entry_id is not null
      union all
      select d.id as document_id, d.org_id, d.subsidiary_id, d.currency as txn_currency,
             d.fx_rate::text as stored_fx_rate, -(${billingsAmount}) as txn_amount,
             reversal.posting_date as effective_date, 'reversal' as leg
        from documents d
        join journal_entries reversal
          on reversal.org_id = d.org_id and reversal.id = d.reversal_entry_id
         and reversal.status in ('posted', 'reversed')
       where d.org_id = ${orgId} and d.kind in ('customer_invoice', 'customer_credit')
         and d.status = 'voided' and d.posted_entry_id is not null
    ), scoped_legs as (
      select document_id, org_id, leg, txn_currency, stored_fx_rate, txn_amount, effective_date,
             coalesce(subsidiary_id, (select id from subsidiaries where org_id = billing_legs.org_id and parent_id is null)) as subsidiary_id
        from billing_legs
    )
    select scoped.document_id, scoped.leg, scoped.subsidiary_id,
           sub.base_currency as functional_currency,
           scoped.txn_currency, scoped.txn_amount::text as txn_amount,
           scoped.stored_fx_rate, scoped.effective_date::text as effective_date
      from scoped_legs scoped
      join subsidiaries sub on sub.org_id = scoped.org_id and sub.id = scoped.subsidiary_id
     where scoped.effective_date >= ${month}::date
       and scoped.effective_date < (${month}::date + interval '1 month')
     order by scoped.document_id, scoped.leg
  `)).rows;
  const cohortStartRows = (await executor.execute<{
    subsidiary_id: string;
    cohort_month: string;
    start_mrr: string;
    start_customers: number;
    reporting_currency: string | null;
    denomination_version: string | null;
  }>(sql`
    select subsidiary_id, cohort_month::text, start_mrr::text, start_customers,
           reporting_currency, denomination_version
      from saas_metrics_cohort_monthly
     where org_id = ${orgId} and month = cohort_month and cohort_month <= ${month}::date
     order by subsidiary_id, cohort_month
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
    revenueBuckets,
    deferredBuckets,
    ledgerBuckets,
    billingLegs,
    cohortStartRows,
  };
}

function mapHistory(history: HistoryRow[]) {
  const bySubscription = new Map<string, HistoryRow[]>();
  for (const row of history) bySubscription.set(row.subscription_id, [...(bySubscription.get(row.subscription_id) ?? []), row]);
  return bySubscription;
}

type MonthlyNormalization = {
  rows: MonthlySubscriptionFact[];
  monthlyEvidence: Record<string, Record<string, unknown>>;
  glBySubsidiary: Map<string, { functionalCurrency: string; revenue: string; cogs: string }>;
  billingsBySubsidiary: Map<string, string>;
  deferredBalanceBySubscription: Map<string, string>;
  glEvidence: Record<string, Record<string, unknown>>;
  billingsEvidence: Record<string, Record<string, unknown>>;
};

async function computeRows(
  executor: SqlExecutor,
  orgId: string,
  month: string,
  sources: Awaited<ReturnType<typeof readSources>>,
): Promise<MonthlyNormalization> {
  const historyBySubscription = mapHistory(sources.history);
  const baseCurrency = sources.baseCurrency;
  const fx: FxEvidenceCache = { asOf: new Map(), monthAverage: new Map() };
  const monthEnd = sources.monthEnd;
  const targetYear = Number(month.slice(0, 4));
  const targetMonth = Number(month.slice(5, 7));
  const previousMonthStart = sources.previousMonth;
  const previousBounds = await executor.execute<{ previous_month_end: string }>(sql`
    select (${previousMonthStart}::date + interval '1 month - 1 day')::date::text as previous_month_end
  `);
  const previousMonthEnd = previousBounds.rows[0]!.previous_month_end;
  const rows: MonthlySubscriptionFact[] = [];
  const monthlyEvidence: MonthlyNormalization["monthlyEvidence"] = {};
  const deferredBalanceBySubscription = new Map<string, string>();
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
    const sourceCurrency = (source.plan_currency ?? baseCurrency).trim().toUpperCase();
    const monthStatus = statusAtMonthEnd(source, monthEnd);
    const normalized = () => monthlyRecurringRevenue(
      source.price_override ?? source.plan_amount,
      source.interval,
      source.interval_count,
      source.quantity,
    );
    // MRR keeps its shipped convention: plan currency to org base at the
    // target month end, with the as-of evidence attached.
    const mrrEvidence = await asOfEvidence(executor, orgId, fx, {
      measure: "subscription MRR",
      from: sourceCurrency,
      to: baseCurrency,
      onDate: monthEnd,
      field: "plan_currency",
      context: `subscription ${source.id}`,
    });
    const mrrEnd = monthStatus === "active"
      ? mulDecimal(normalized(), mrrEvidence.rate!)
      : "0.0000";
    const history = historyBySubscription.get(source.id) ?? [];
    // Every consumed history row validates first — including rows consulted
    // only for sign below, which never bypass the rollout refusal.
    for (const row of history) {
      validatedHistoryCurrency({
        scope: `Subscription ${source.id} history for ${row.month.slice(0, 10)}`,
        month,
        sourceMonth: row.month.slice(0, 10),
        reportingCurrency: row.reporting_currency,
        denominationVersion: row.denomination_version,
      });
    }
    const priorMonth = history.find((row) => row.month.slice(0, 10) === previousMonthStart);
    const previousStatus = statusAtMonthEnd(source, previousMonthEnd);
    // A month opens from its predecessor's persisted closing MRR, converted
    // to the current org base at the prior month end when the predecessor
    // was denominated elsewhere. Same-currency v1 rows reuse their amount
    // with explicit no-conversion evidence. This lands before movement
    // classification and aggregation, and the opening evidence joins the
    // canonical hash through the monthly evidence below.
    let mrrStart = "0.0000";
    let openingTranslation: Record<string, unknown> | null = null;
    let previousEvidence: FxAsOfEvidence | null = null;
    if (priorMonth) {
      const priorCurrency = validatedHistoryCurrency({
        scope: `Subscription ${source.id} closing MRR for ${previousMonthStart}`,
        month,
        sourceMonth: previousMonthStart,
        reportingCurrency: priorMonth.reporting_currency,
        denominationVersion: priorMonth.denomination_version,
      });
      const opening = await asOfEvidence(executor, orgId, fx, {
        measure: "opening MRR",
        from: priorCurrency,
        to: baseCurrency,
        onDate: previousMonthEnd,
        field: "month",
        context: `subscription ${source.id} opening from ${previousMonthStart}`,
      });
      mrrStart = mulDecimal(priorMonth.mrr_end, opening.rate!);
      openingTranslation = {
        prior_month: previousMonthStart,
        prior_month_end: previousMonthEnd,
        prior_mrr_end: priorMonth.mrr_end,
        prior_reporting_currency: priorCurrency,
        prior_denomination_version: priorMonth.denomination_version,
        opening_rate: opening,
      };
    } else if (source.start_on <= previousMonthEnd && previousStatus === "active") {
      previousEvidence = await asOfEvidence(executor, orgId, fx, {
        measure: "subscription MRR",
        from: sourceCurrency,
        to: baseCurrency,
        onDate: previousMonthEnd,
        field: "plan_currency",
        context: `subscription ${source.id}`,
      });
      mrrStart = mulDecimal(normalized(), previousEvidence.rate!);
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
    // Recognized revenue translates every subsidiary-functional journal line
    // to org base with the target calendar-month average — after the
    // single-subsidiary attribution check above, before any sum.
    const revenueBucket = attributedBucket({
      measure: "recognized revenue",
      subscriptionId: source.id,
      trustedSubsidiaryId: subsidiaryId,
      buckets: sources.revenueBuckets.filter((bucket) => bucket.subscription_id === source.id),
    });
    let recognizedRevenue = "0.0000";
    let revenueTranslation: Record<string, unknown> | null = null;
    if (revenueBucket) {
      const average = await monthAverageEvidence(executor, orgId, fx, {
        measure: "recognized revenue",
        from: revenueBucket.functional_currency,
        to: baseCurrency,
        year: targetYear,
        month: targetMonth,
        field: "recognized_revenue",
        context: `subscription ${source.id} in subsidiary ${revenueBucket.subsidiary_id}`,
      });
      recognizedRevenue = mulDecimal(revenueBucket.revenue, average.rate!);
      revenueTranslation = {
        subsidiary_id: revenueBucket.subsidiary_id,
        functional_currency: revenueBucket.functional_currency,
        functional_amount: revenueBucket.revenue,
        calendar_month_average: average,
        amount: recognizedRevenue,
      };
    }
    // Deferred stock and flow both translate at the target month end —
    // never entry-period current, never a future date.
    const deferredBucket = attributedBucket({
      measure: "deferred revenue",
      subscriptionId: source.id,
      trustedSubsidiaryId: subsidiaryId,
      buckets: sources.deferredBuckets.filter((bucket) => bucket.subscription_id === source.id),
    });
    let deferredDelta = "0.0000";
    let deferredBalance = "0.0000";
    let deferredTranslation: Record<string, unknown> | null = null;
    if (deferredBucket) {
      const closing = await asOfEvidence(executor, orgId, fx, {
        measure: "deferred revenue",
        from: deferredBucket.functional_currency,
        to: baseCurrency,
        onDate: monthEnd,
        field: "deferred_delta",
        context: `subscription ${source.id} in subsidiary ${deferredBucket.subsidiary_id}`,
      });
      deferredDelta = mulDecimal(deferredBucket.deferred_delta, closing.rate!);
      deferredBalance = mulDecimal(deferredBucket.deferred_balance, closing.rate!);
      deferredTranslation = {
        subsidiary_id: deferredBucket.subsidiary_id,
        functional_currency: deferredBucket.functional_currency,
        functional_delta: deferredBucket.deferred_delta,
        functional_balance: deferredBucket.deferred_balance,
        target_month_end: closing,
        deferred_delta: deferredDelta,
        deferred_balance: deferredBalance,
      };
    }
    deferredBalanceBySubscription.set(source.id, deferredBalance);
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
      recognizedRevenue,
      deferredDelta,
      booking: mul(bookedRecurring, rawTermMonths),
    });
    monthlyEvidence[source.id] = {
      denomination_version: SAAS_METRICS_DENOMINATION_VERSION,
      reporting_currency: baseCurrency,
      billing_subsidiary: subsidiaryId,
      mrr: {
        plan_currency: sourceCurrency,
        target_month_end: monthEnd,
        month_end_rate: mrrEvidence,
        previous_month_end_rate: previousEvidence,
        opening: openingTranslation,
        mrr_start: mrrStart,
        mrr_end: mrrEnd,
      },
      recognized_revenue: revenueTranslation,
      deferred: deferredTranslation,
      booking: { term_months: rawTermMonths, booked_recurring: bookedRecurring },
    };
  }
  // GL revenue and COGS translate per legal entity at the target
  // calendar-month average of dated spots for that entity's functional
  // currency to org base.
  const glBySubsidiary: MonthlyNormalization["glBySubsidiary"] = new Map();
  const glEvidence: MonthlyNormalization["glEvidence"] = {};
  for (const bucket of sources.ledgerBuckets) {
    const average = await monthAverageEvidence(executor, orgId, fx, {
      measure: "GL revenue and COGS",
      from: bucket.functional_currency,
      to: baseCurrency,
      year: targetYear,
      month: targetMonth,
      field: "gl_revenue",
      context: `subsidiary ${bucket.subsidiary_id}`,
    });
    const revenue = mulDecimal(bucket.revenue, average.rate!);
    const cogs = mulDecimal(bucket.cogs, average.rate!);
    glBySubsidiary.set(bucket.subsidiary_id, { functionalCurrency: bucket.functional_currency, revenue, cogs });
    glEvidence[bucket.subsidiary_id] = {
      denomination_version: SAAS_METRICS_DENOMINATION_VERSION,
      reporting_currency: baseCurrency,
      functional_currency: bucket.functional_currency,
      functional_revenue: bucket.revenue,
      functional_cogs: bucket.cogs,
      calendar_month_average: average,
      gl_revenue: revenue,
      gl_cogs: cogs,
    };
  }
  // Billings convert strictly two-leg per document leg: the transaction
  // amount through the document's stored posting FX into the owning
  // subsidiary's functional currency, then that functional amount through
  // the metric month average into org base. Reversal legs reuse the original
  // stored first-leg rate with the reversal month's second-leg evidence.
  // The transaction currency is never averaged directly to org base.
  const billingsBySubsidiary = new Map<string, string>();
  const billingsEvidence: MonthlyNormalization["billingsEvidence"] = {};
  const legEvidenceBySubsidiary = new Map<string, Record<string, unknown>[]>();
  for (const leg of sources.billingLegs) {
    const functionalAmount = mulDecimal(leg.txn_amount, leg.stored_fx_rate);
    const legYear = Number(leg.effective_date.slice(0, 4));
    const legMonth = Number(leg.effective_date.slice(5, 7));
    const average = await monthAverageEvidence(executor, orgId, fx, {
      measure: "billings",
      from: leg.functional_currency,
      to: baseCurrency,
      year: legYear,
      month: legMonth,
      field: "billings",
      context: `document ${leg.document_id} (${leg.leg} leg) in subsidiary ${leg.subsidiary_id}`,
    });
    const baseAmount = mulDecimal(functionalAmount, average.rate!);
    billingsBySubsidiary.set(
      leg.subsidiary_id,
      add(billingsBySubsidiary.get(leg.subsidiary_id) ?? "0.0000", baseAmount),
    );
    legEvidenceBySubsidiary.set(leg.subsidiary_id, [
      ...(legEvidenceBySubsidiary.get(leg.subsidiary_id) ?? []),
      {
        document_id: leg.document_id,
        leg: leg.leg,
        effective_date: leg.effective_date,
        txn_currency: leg.txn_currency,
        txn_amount: leg.txn_amount,
        stored_posting_fx_rate: leg.stored_fx_rate,
        functional_currency: leg.functional_currency,
        functional_amount: functionalAmount,
        calendar_month_average: average,
        amount: baseAmount,
      },
    ]);
  }
  for (const [subsidiaryId, legs] of legEvidenceBySubsidiary) {
    billingsEvidence[subsidiaryId] = {
      denomination_version: SAAS_METRICS_DENOMINATION_VERSION,
      reporting_currency: baseCurrency,
      legs,
      billings: billingsBySubsidiary.get(subsidiaryId) ?? "0.0000",
    };
  }
  return {
    rows,
    monthlyEvidence,
    glBySubsidiary,
    billingsBySubsidiary,
    deferredBalanceBySubscription,
    glEvidence,
    billingsEvidence,
  };
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
  glBySubsidiary: Map<string, { functionalCurrency: string; revenue: string; cogs: string }>,
  billingsBySubsidiary: Map<string, string>,
  deferredBalanceBySubscription: Map<string, string>,
  basis: FactsRow["basis"],
): FactsRow[] {
  // Liveness is denomination-invariant but still consumes each row, so every
  // row validates before its sign is read.
  for (const row of history) {
    validatedHistoryCurrency({
      scope: `Customer history for ${row.month.slice(0, 10)} in subsidiary ${row.subsidiary_id}`,
      month,
      sourceMonth: row.month.slice(0, 10),
      reportingCurrency: row.reporting_currency,
      denominationVersion: row.denomination_version,
    });
  }
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
      glRevenue: glBySubsidiary.get(subsidiaryId)?.revenue ?? "0.0000",
      glCogs: glBySubsidiary.get(subsidiaryId)?.cogs ?? "0.0000",
      bookings: moneySum(scoped.map((row) => row.booking)),
      billings: billingsBySubsidiary.get(subsidiaryId) ?? "0.0000",
      deferredBalance: moneySum(scoped.map((row) => deferredBalanceBySubscription.get(row.subscriptionId) ?? "0.0000")),
      basis,
    });
  }
  return facts;
}

type CohortFact = {
  subsidiaryId: string;
  cohortMonth: string;
  month: string;
  monthsSinceStart: number;
  startMrr: string;
  mrr: string;
  startCustomers: number;
  customers: number;
  opening: Record<string, unknown>;
};

async function aggregateCohorts(
  executor: SqlExecutor,
  orgId: string,
  baseCurrency: string,
  month: string,
  rows: MonthlySubscriptionFact[],
  history: HistoryRow[],
  cohortStarts: Awaited<ReturnType<typeof readSources>>["cohortStartRows"],
): Promise<CohortFact[]> {
  const fx: FxEvidenceCache = { asOf: new Map(), monthAverage: new Map() };
  const monthEnds = new Map<string, string>();
  const cohortMonthEnd = async (cohortMonth: string): Promise<string> => {
    let end = monthEnds.get(cohortMonth);
    if (!end) {
      end = await monthEndFor(executor, cohortMonth);
      monthEnds.set(cohortMonth, end);
    }
    return end;
  };
  // A cohort opening is a persisted amount in its own recorded denomination:
  // it converts to the current org base at the cohort month end, exactly
  // like a prior-month opening converts at the prior month end. Customer
  // counts stay counts and are never converted.
  const normalizeOpening = async (args: {
    subsidiaryId: string;
    cohortMonth: string;
    rawAmount: string;
    reportingCurrency: string | null;
    denominationVersion: string | null;
    scope: string;
  }): Promise<{ amount: string; conversion: FxAsOfEvidence }> => {
    const currency = validatedHistoryCurrency({
      scope: args.scope,
      month,
      sourceMonth: args.cohortMonth,
      reportingCurrency: args.reportingCurrency,
      denominationVersion: args.denominationVersion,
    });
    const conversion = await asOfEvidence(executor, orgId, fx, {
      measure: "cohort opening",
      from: currency,
      to: baseCurrency,
      onDate: await cohortMonthEnd(args.cohortMonth),
      field: "month",
      context: `${args.scope} at ${args.cohortMonth} month end`,
    });
    return { amount: mulDecimal(args.rawAmount, conversion.rate!), conversion };
  };
  const groups = new Map<string, MonthlySubscriptionFact[]>();
  for (const row of rows) {
    const key = `${row.subsidiaryId}:${row.cohortMonth}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const facts: CohortFact[] = [];
  for (const [key, cohortRows] of groups) {
    const separator = key.indexOf(":");
    const subsidiaryId = key.slice(0, separator);
    const cohortMonth = key.slice(separator + 1);
    const storedStart = cohortStarts.find((row) => row.subsidiary_id === subsidiaryId && row.cohort_month.slice(0, 10) === cohortMonth);
    const historicalStartRows = history.filter((row) =>
      row.subsidiary_id === subsidiaryId
      && row.month.slice(0, 10) === cohortMonth
      && row.cohort_month.slice(0, 10) === cohortMonth
    );
    if (cohortMonth < month && historicalStartRows.length === 0 && storedStart === undefined) {
      throw refusal(
        "saas_metrics_cohort_start_missing",
        `The opening month ${cohortMonth} for SaaS cohort ${cohortMonth} in subsidiary ${subsidiaryId} has not been computed.`,
        `Recompute the cohort's opening month ${cohortMonth} before recomputing ${month}.`,
      );
    }
    let startMrr: string;
    let startCustomers: number;
    let opening: Record<string, unknown>;
    if (storedStart !== undefined) {
      const normalized = await normalizeOpening({
        subsidiaryId,
        cohortMonth,
        rawAmount: storedStart.start_mrr,
        reportingCurrency: storedStart.reporting_currency,
        denominationVersion: storedStart.denomination_version,
        scope: `SaaS cohort opening for ${cohortMonth} in subsidiary ${subsidiaryId}`,
      });
      startMrr = normalized.amount;
      startCustomers = storedStart.start_customers;
      opening = {
        source: "stored",
        cohort_month: cohortMonth,
        cohort_month_end: await cohortMonthEnd(cohortMonth),
        raw_start_mrr: storedStart.start_mrr,
        raw_reporting_currency: storedStart.reporting_currency,
        raw_denomination_version: storedStart.denomination_version,
        raw_start_customers: storedStart.start_customers,
        conversion: normalized.conversion,
      };
    } else if (cohortMonth === month) {
      startMrr = moneySum(cohortRows.map((row) => row.mrrEnd));
      startCustomers = new Set(cohortRows.filter((row) => cmp(row.mrrEnd, "0") > 0).map((row) => row.customerId)).size;
      opening = {
        source: "opening",
        cohort_month: cohortMonth,
        start_mrr: startMrr,
        start_customers: startCustomers,
      };
    } else {
      const converted = await Promise.all(historicalStartRows.map(async (row) => normalizeOpening({
        subsidiaryId,
        cohortMonth,
        rawAmount: row.mrr_end,
        reportingCurrency: row.reporting_currency,
        denominationVersion: row.denomination_version,
        scope: `Subscription ${row.subscription_id} opening-month MRR for ${cohortMonth}`,
      })));
      startMrr = moneySum(converted.map((entry) => entry.amount));
      startCustomers = new Set(
        historicalStartRows.filter((row) => cmp(row.mrr_end, "0") > 0).map((row) => row.customer_id),
      ).size;
      opening = {
        source: "historical",
        cohort_month: cohortMonth,
        cohort_month_end: await cohortMonthEnd(cohortMonth),
        rows: historicalStartRows.map((row, index) => ({
          subscription_id: row.subscription_id,
          raw_mrr_end: row.mrr_end,
          raw_reporting_currency: row.reporting_currency,
          raw_denomination_version: row.denomination_version,
          conversion: converted[index]!.conversion,
        })),
        start_customers: startCustomers,
      };
    }
    facts.push({
      subsidiaryId,
      cohortMonth,
      month,
      monthsSinceStart: monthOrdinal(month) - monthOrdinal(cohortMonth),
      startMrr,
      mrr: moneySum(cohortRows.map((row) => row.mrrEnd)),
      startCustomers,
      customers: new Set(cohortRows.filter((row) => cmp(row.mrrEnd, "0") > 0).map((row) => row.customerId)).size,
      opening,
    });
  }
  return facts;
}

async function writeMonthlyRow(
  executor: SqlExecutor,
  row: MonthlySubscriptionFact,
  reportingCurrency: string,
  evidence: Record<string, unknown>,
  inputsHash: string,
): Promise<void> {
  const result = await executor.execute<{ id: string }>(sql`
    insert into saas_metrics_monthly
      (org_id, subsidiary_id, customer_id, subscription_id, month, cohort_month,
       mrr_start, mrr_end, new_mrr, expansion_mrr, contraction_mrr, churned_mrr,
       reactivation_mrr, movement, recognized_revenue, deferred_delta, inputs_hash,
       reporting_currency, denomination_version, normalization_evidence, computed_at)
    values
      (${row.orgId}, ${row.subsidiaryId}, ${row.customerId}, ${row.subscriptionId}, ${row.month}::date,
       ${row.cohortMonth}::date, ${row.mrrStart}, ${row.mrrEnd}, ${row.newMrr}, ${row.expansionMrr},
       ${row.contractionMrr}, ${row.churnedMrr}, ${row.reactivationMrr}, ${row.movement},
       ${row.recognizedRevenue}, ${row.deferredDelta}, ${inputsHash},
       ${reportingCurrency}, ${SAAS_METRICS_DENOMINATION_VERSION}, ${JSON.stringify(evidence)}::jsonb, now())
    on conflict (org_id, month, subscription_id) do update set
      subsidiary_id = excluded.subsidiary_id, customer_id = excluded.customer_id,
      cohort_month = excluded.cohort_month, mrr_start = excluded.mrr_start, mrr_end = excluded.mrr_end,
      new_mrr = excluded.new_mrr, expansion_mrr = excluded.expansion_mrr,
      contraction_mrr = excluded.contraction_mrr, churned_mrr = excluded.churned_mrr,
      reactivation_mrr = excluded.reactivation_mrr, movement = excluded.movement,
      recognized_revenue = excluded.recognized_revenue, deferred_delta = excluded.deferred_delta,
      inputs_hash = excluded.inputs_hash,
      reporting_currency = excluded.reporting_currency,
      denomination_version = excluded.denomination_version,
      normalization_evidence = excluded.normalization_evidence,
      computed_at = excluded.computed_at
    returning id
  `);
  if (result.rows.length !== 1) throw refusal("saas_metrics_subscription_write_missing", `Metrics for subscription ${row.subscriptionId} were not stored.`, "Retry the recompute after confirming that the subscription remains in the organization.");
}

async function writeFactsRow(
  executor: SqlExecutor,
  orgId: string,
  row: FactsRow,
  reportingCurrency: string,
  evidence: Record<string, unknown>,
  inputsHash: string,
): Promise<void> {
  const result = await executor.execute<{ id: string }>(sql`
    insert into saas_metrics_facts_monthly
      (org_id, subsidiary_id, month, mrr_start, mrr_end, new_mrr, expansion_mrr,
       contraction_mrr, churned_mrr, reactivation_mrr, recognized_revenue, deferred_delta,
       mrr_at_risk, customers_start,
       customers_end, customers_new, customers_churned, customers_reactivated,
       gl_revenue, gl_cogs, bookings, billings, deferred_balance, basis, inputs_hash,
       reporting_currency, denomination_version, normalization_evidence, computed_at)
    values
      (${orgId}, ${row.subsidiaryId}, ${row.month}::date, ${row.mrrStart}, ${row.mrrEnd},
       ${row.newMrr}, ${row.expansionMrr}, ${row.contractionMrr}, ${row.churnedMrr},
       ${row.reactivationMrr}, ${row.recognizedRevenue}, ${row.deferredDelta}, ${row.mrrAtRisk},
       ${row.customersStart}, ${row.customersEnd},
       ${row.customersNew}, ${row.customersChurned}, ${row.customersReactivated},
       ${row.glRevenue}, ${row.glCogs}, ${row.bookings}, ${row.billings}, ${row.deferredBalance},
       ${row.basis}, ${inputsHash},
       ${reportingCurrency}, ${SAAS_METRICS_DENOMINATION_VERSION}, ${JSON.stringify(evidence)}::jsonb, now())
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
      inputs_hash = excluded.inputs_hash,
      reporting_currency = excluded.reporting_currency,
      denomination_version = excluded.denomination_version,
      normalization_evidence = excluded.normalization_evidence,
      computed_at = excluded.computed_at
    returning id
  `);
  if (result.rows.length !== 1) throw refusal("saas_metrics_facts_write_missing", `Monthly facts for subsidiary ${row.subsidiaryId} were not stored.`, "Retry the recompute after confirming that the subsidiary remains active.");
}

async function writeCohortRow(
  executor: SqlExecutor,
  orgId: string,
  row: CohortFact,
  reportingCurrency: string,
  evidence: Record<string, unknown>,
  inputsHash: string,
): Promise<void> {
  const result = await executor.execute<{ id: string }>(sql`
    insert into saas_metrics_cohort_monthly
      (org_id, subsidiary_id, cohort_month, month, months_since_start, start_mrr, mrr,
       start_customers, customers, inputs_hash,
       reporting_currency, denomination_version, normalization_evidence, computed_at)
    values (${orgId}, ${row.subsidiaryId}, ${row.cohortMonth}::date, ${row.month}::date,
            ${row.monthsSinceStart}, ${row.startMrr}, ${row.mrr}, ${row.startCustomers},
            ${row.customers}, ${inputsHash},
            ${reportingCurrency}, ${SAAS_METRICS_DENOMINATION_VERSION}, ${JSON.stringify(evidence)}::jsonb, now())
    on conflict (org_id, subsidiary_id, cohort_month, month) do update set
      months_since_start = excluded.months_since_start, start_mrr = excluded.start_mrr,
      mrr = excluded.mrr, start_customers = excluded.start_customers, customers = excluded.customers,
      inputs_hash = excluded.inputs_hash,
      reporting_currency = excluded.reporting_currency,
      denomination_version = excluded.denomination_version,
      normalization_evidence = excluded.normalization_evidence,
      computed_at = excluded.computed_at
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
    const reportingCurrency = sources.baseCurrency;
    const computed = await computeRows(db, orgId, month, sources);
    const basis: FactsRow["basis"] = sources.revenueRecognitionEnabled ? "recognised" : "billed";
    const facts = aggregateFacts(
      month,
      sources.subsidiaries.map((row) => row.id),
      computed.rows,
      sources.history,
      computed.glBySubsidiary,
      computed.billingsBySubsidiary,
      computed.deferredBalanceBySubscription,
      basis,
    );
    const cohorts = await aggregateCohorts(db, orgId, reportingCurrency, month, computed.rows, sources.history, sources.cohortStartRows);
    // Per-row evidence bodies first (without their digest), then one
    // canonical versioned hash over the exact inputs-plus-evidence payload.
    // Every stored row carries the same digest in its evidence and its
    // inputs_hash column, so any later recompute either reproduces it or
    // reports changed inputs for the closed-month freeze to refuse.
    const factsEvidence: Record<string, Record<string, unknown>> = {};
    for (const fact of facts) {
      factsEvidence[fact.subsidiaryId] = {
        denomination_version: SAAS_METRICS_DENOMINATION_VERSION,
        reporting_currency: reportingCurrency,
        gl: computed.glEvidence[fact.subsidiaryId] ?? null,
        billings: computed.billingsEvidence[fact.subsidiaryId] ?? null,
        subscriptions: computed.rows
          .filter((row) => row.subsidiaryId === fact.subsidiaryId)
          .map((row) => computed.monthlyEvidence[row.subscriptionId]),
      };
    }
    const cohortsEvidence = cohorts.map((cohort) => ({
      denomination_version: SAAS_METRICS_DENOMINATION_VERSION,
      reporting_currency: reportingCurrency,
      subsidiary_id: cohort.subsidiaryId,
      cohort_month: cohort.cohortMonth,
      months_since_start: cohort.monthsSinceStart,
      start_mrr: cohort.startMrr,
      mrr: cohort.mrr,
      opening: cohort.opening,
      member_subscriptions: computed.rows
        .filter((row) => row.subsidiaryId === cohort.subsidiaryId && row.cohortMonth === cohort.cohortMonth)
        .map((row) => row.subscriptionId)
        .sort(),
    }));
    const inputs = {
      baseCurrency: reportingCurrency,
      revenueRecognitionEnabled: sources.revenueRecognitionEnabled,
      subscriptions: computed.rows,
      history: sources.history,
      cohortStarts: sources.cohortStartRows,
      definitions: sources.definitions,
      revenueBuckets: sources.revenueBuckets,
      deferredBuckets: sources.deferredBuckets,
      ledgerBuckets: sources.ledgerBuckets,
      billingLegs: sources.billingLegs,
      subsidiaries: sources.subsidiaries,
    };
    const evidence = {
      monthly: computed.monthlyEvidence,
      facts: factsEvidence,
      cohorts: cohortsEvidence,
    };
    const monthHash = normalizationInputsHash({
      denominationVersion: SAAS_METRICS_DENOMINATION_VERSION,
      orgId,
      month,
      reportingCurrency,
      inputs,
      evidence,
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
    for (const row of computed.rows) {
      await writeMonthlyRow(db, row, reportingCurrency, {
        ...computed.monthlyEvidence[row.subscriptionId]!,
        inputs_hash: monthHash,
      }, monthHash);
    }
    for (const row of facts) {
      await writeFactsRow(db, orgId, row, reportingCurrency, {
        ...factsEvidence[row.subsidiaryId]!,
        inputs_hash: monthHash,
      }, monthHash);
    }
    for (const [index, row] of cohorts.entries()) {
      await writeCohortRow(db, orgId, row, reportingCurrency, {
        ...cohortsEvidence[index]!,
        inputs_hash: monthHash,
      }, monthHash);
    }
    return { orgId, month, subscriptionRows: computed.rows.length, subsidiaryRows: facts.length, frozen: !closeState.open };
  });
}

export interface SaasMetricsMonth {
  month: string;
  computedAt: string;
  frozen: boolean;
}

/** Read the recorded facts and their period-close state for the metrics API. */
export async function listSaasMetricsMonths(orgId: string): Promise<SaasMetricsMonth[]> {
  if (!(await orgFeatureEnabled(orgId, "saasMetrics"))) {
    throw refusal("feature_off", "SaaS metrics are disabled for this organization.", FEATURES_REMEDY);
  }
  return withOrgTransaction(orgId, async () => {
    const rows = (await db.execute<{ month: string; computedAt: string }>(sql`
      select month, max(computed_at)::text as "computedAt"
        from (
          select month::text as month, computed_at from saas_metrics_monthly where org_id = ${orgId}
          union all
          select month::text as month, computed_at from saas_metrics_facts_monthly where org_id = ${orgId}
          union all
          select month::text as month, computed_at from saas_metrics_cohort_monthly where org_id = ${orgId}
        ) facts
       group by month order by month desc`)).rows;
    const subsidiaries = (await db.execute<SubsidiaryRow>(sql`
      select id, base_currency from subsidiaries where org_id = ${orgId} and is_active and not is_elimination order by id`)).rows;
    const result: SaasMetricsMonth[] = [];
    for (const row of rows) {
      const close = await monthCloseState(db, orgId, row.month, subsidiaries.map((subsidiary) => subsidiary.id));
      result.push({ month: row.month, computedAt: row.computedAt, frozen: !close.open });
    }
    return result;
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
      select id, base_currency from subsidiaries where org_id = ${orgId} and is_active and not is_elimination order by id
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
