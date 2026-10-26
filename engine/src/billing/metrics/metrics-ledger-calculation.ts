import { sql } from "drizzle-orm";
import { add, cmp, neg } from "../../money/money.ts";
import {
  averageSpotRateForMonthWithEvidence,
  lookupSpotRateWithEvidence,
  type FxAsOfEvidence,
  type FxMonthAverageEvidence,
} from "../../fx/spot-rate.ts";
import { arePeriodModulesOpen } from "../../periods/period-policy.ts";
import { type SqlExecutor } from "../../platform/db.ts";
import { type Interval } from "../subscription-billing.ts";
import { UsageBillingError } from "../usage/errors.ts";
import { SAAS_METRICS_DENOMINATION_VERSION } from "./metrics-normalization.ts";

export type SubscriptionSource = {
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

export type HistoryRow = {
  subscription_id: string;
  customer_id: string;
  subsidiary_id: string;
  month: string;
  cohort_month: string;
  mrr_end: string;
  reporting_currency: string | null;
  denomination_version: string | null;
};

export type MonthlySubscriptionFact = {
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

export type RevenueBucket = {
  subscription_id: string;
  subsidiary_id: string;
  functional_currency: string;
  entry_ids: string[];
  revenue: string;
};
export type DeferredBucket = {
  subscription_id: string;
  subsidiary_id: string;
  functional_currency: string;
  entry_ids: string[];
  deferred_delta: string;
  deferred_balance: string;
};
export type LedgerBucket = {
  subsidiary_id: string;
  functional_currency: string;
  revenue: string;
  cogs: string;
};
export type BillingLeg = {
  document_id: string;
  subsidiary_id: string;
  functional_currency: string;
  txn_currency: string;
  txn_amount: string;
  stored_fx_rate: string;
  leg: string;
  effective_date: string;
};
export type SubsidiaryRow = { id: string; base_currency: string };
type PeriodBookRow = { period_id: string; book_id: string };

export function refusal(
  code: string,
  message: string,
  remedy: string,
  options?: { field?: string | null; status?: 422 | 409 },
): UsageBillingError {
  return new UsageBillingError(code, message, remedy, options);
}

export function moneySum(values: readonly string[]): string {
  return values.reduce((total, value) => add(total, value), "0.0000");
}

export function monthOrdinal(month: string): number {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return year * 12 + monthNumber - 1;
}

export function monthFromOrdinal(ordinal: number): string {
  const year = Math.floor(ordinal / 12);
  const month = (ordinal % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

export function monthStartForDate(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function statusAtMonthEnd(
  source: SubscriptionSource,
  monthEnd: string,
): "active" | "paused" | "canceled" {
  switch (source.status) {
    case "active":
    case "paused":
    case "canceled": {
      const resumedAfterCancel =
        source.canceled_on !== null &&
        source.resume_on !== null &&
        source.resume_on > source.canceled_on &&
        source.resume_on <= monthEnd;
      const canceled =
        source.canceled_on !== null && source.canceled_on <= monthEnd && !resumedAfterCancel;
      if (canceled) return "canceled";
      const resumedAfterPause =
        source.paused_on !== null &&
        source.resume_on !== null &&
        source.resume_on > source.paused_on &&
        source.resume_on <= monthEnd;
      const paused =
        source.paused_on !== null && source.paused_on <= monthEnd && !resumedAfterPause;
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

export function chooseMovement(args: {
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

export function movementAmounts(
  movement: MonthlySubscriptionFact["movement"],
  mrrStart: string,
  mrrEnd: string,
): Pick<
  MonthlySubscriptionFact,
  "newMrr" | "expansionMrr" | "contractionMrr" | "churnedMrr" | "reactivationMrr"
> {
  const delta = add(mrrEnd, neg(mrrStart));
  switch (movement) {
    case "new":
      return {
        newMrr: mrrEnd,
        expansionMrr: "0.0000",
        contractionMrr: "0.0000",
        churnedMrr: "0.0000",
        reactivationMrr: "0.0000",
      };
    case "expansion":
      return {
        newMrr: "0.0000",
        expansionMrr: delta,
        contractionMrr: "0.0000",
        churnedMrr: "0.0000",
        reactivationMrr: "0.0000",
      };
    case "contraction":
      return {
        newMrr: "0.0000",
        expansionMrr: "0.0000",
        contractionMrr: neg(delta),
        churnedMrr: "0.0000",
        reactivationMrr: "0.0000",
      };
    case "churn":
      return {
        newMrr: "0.0000",
        expansionMrr: "0.0000",
        contractionMrr: "0.0000",
        churnedMrr: mrrStart,
        reactivationMrr: "0.0000",
      };
    case "reactivation":
      return {
        newMrr: "0.0000",
        expansionMrr: "0.0000",
        contractionMrr: "0.0000",
        churnedMrr: "0.0000",
        reactivationMrr: mrrEnd,
      };
    case "flat":
      return {
        newMrr: "0.0000",
        expansionMrr: "0.0000",
        contractionMrr: "0.0000",
        churnedMrr: "0.0000",
        reactivationMrr: "0.0000",
      };
  }
}

/** All translations use dated spot-rate evidence; consolidated overrides do not change it. */
export type FxEvidenceCache = {
  asOf: Map<string, FxAsOfEvidence>;
  monthAverage: Map<string, FxMonthAverageEvidence>;
};

function fxRemedy(fromCurrency: string, toCurrency: string, scope: string): string {
  return `Add the dated spot rate ${fromCurrency}→${toCurrency} ${scope} under Company Settings → Setup → FX rates, then recompute the month.`;
}

/** Current (as-of) spot with evidence; refuses by name when the pair is uncovered. */
export async function asOfEvidence(
  executor: SqlExecutor,
  orgId: string,
  cache: FxEvidenceCache,
  args: {
    measure: string;
    from: string;
    to: string;
    onDate: string;
    field: string;
    context: string;
  },
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

/** Uses the full calendar month and refuses when no dated observation exists. */
export async function monthAverageEvidence(
  executor: SqlExecutor,
  orgId: string,
  cache: FxEvidenceCache,
  args: {
    measure: string;
    from: string;
    to: string;
    year: number;
    month: number;
    field: string;
    context: string;
  },
): Promise<FxMonthAverageEvidence> {
  const month = `${args.year}-${String(args.month).padStart(2, "0")}`;
  const key = `${args.from}→${args.to}:${month}`;
  let evidence = cache.monthAverage.get(key);
  if (!evidence) {
    evidence = await averageSpotRateForMonthWithEvidence(
      executor,
      orgId,
      args.from,
      args.to,
      args.year,
      args.month,
    );
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

/** Requires every non-empty journal source to belong to its subscription's billing subsidiary. */
export function attributedBucket<
  Bucket extends { subsidiary_id: string; entry_ids: string[] },
>(args: {
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

/** Historical metrics require reporting currency and denomination evidence from governed normalization. */
export function validatedHistoryCurrency(args: {
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
      `Open Company Setup → SaaS Metrics and submit a normalization request for ${args.sourceMonth}; complete any tenant Flow gates, then recompute ${args.month}. Closed periods remain closed and posted accounting history is never reversed or rewritten to normalize derived metrics.`,
      { field: "month" },
    );
  }
  return currency;
}

/** Calendar month-end for a month start, for cohort-opening translation. */
export async function monthEndFor(executor: SqlExecutor, monthStart: string): Promise<string> {
  const bounds = await executor.execute<{ month_end: string }>(
    sql`
    select (${monthStart}::date + interval '1 month - 1 day')::date::text as month_end
  `,
    "objects",
  );
  return bounds[0]!.month_end;
}

export async function monthCloseState(
  executor: SqlExecutor,
  orgId: string,
  month: string,
  subsidiaryIds: string[],
): Promise<{ open: boolean; periodIds: string[] }> {
  const monthData = await executor.execute<{ month_end: string }>(
    sql`
    select (${month}::date + interval '1 month - 1 day')::date::text as month_end
  `,
    "objects",
  );
  const monthEnd = monthData[0]!.month_end;
  const periodBooks = await executor.execute<PeriodBookRow>(
    sql`
    select p.id as period_id, b.id as book_id
      from accounting_periods p
      join fiscal_calendars c on c.org_id = p.org_id and c.id = p.fiscal_calendar_id
      join accounting_books b on b.org_id = p.org_id and b.is_primary and b.is_active and b.posts_gl
     where p.org_id = ${orgId} and c.is_default and c.is_active and not p.is_adjustment
       and p.starts_on <= ${monthEnd}::date and p.ends_on >= ${month}::date
     order by p.id, b.id
  `,
    "objects",
  );
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
