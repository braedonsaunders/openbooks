import { sql } from "drizzle-orm";
import { add, cmp, mul, mulDecimal, neg } from "../../money/money.ts";
import { type FxAsOfEvidence } from "../../fx/spot-rate.ts";
import { type SqlExecutor } from "../../platform/db.ts";
import { monthlyRecurringRevenue } from "../subscription-billing.ts";
import { SAAS_METRICS_DENOMINATION_VERSION } from "./metrics-normalization.ts";
import {
  asOfEvidence,
  attributedBucket,
  chooseMovement,
  monthAverageEvidence,
  monthOrdinal,
  monthStartForDate,
  movementAmounts,
  refusal,
  statusAtMonthEnd,
  validatedHistoryCurrency,
} from "./metrics-ledger-calculation.ts";
import type { FxEvidenceCache, MonthlySubscriptionFact } from "./metrics-ledger-calculation.ts";
import { mapHistory, readSources } from "./metrics-ledger-source-reading.ts";

export type MonthlyNormalization = {
  rows: MonthlySubscriptionFact[];
  monthlyEvidence: Record<string, Record<string, unknown>>;
  glBySubsidiary: Map<string, { functionalCurrency: string; revenue: string; cogs: string }>;
  billingsBySubsidiary: Map<string, string>;
  deferredBalanceBySubscription: Map<string, string>;
  glEvidence: Record<string, Record<string, unknown>>;
  billingsEvidence: Record<string, Record<string, unknown>>;
};

type SubscriptionMetricBase = {
  subsidiaryId: string;
  sourceCurrency: string;
  mrrEvidence: FxAsOfEvidence;
  previousEvidence: FxAsOfEvidence | null;
  openingTranslation: Record<string, unknown> | null;
  mrrStart: string;
  mrrEnd: string;
  amounts: ReturnType<typeof movementAmounts>;
  movement: MonthlySubscriptionFact["movement"];
  rawTermMonths: string;
  bookedRecurring: string;
};

async function computeSubscriptionBase(args: {
  executor: SqlExecutor;
  orgId: string;
  month: string;
  sources: Awaited<ReturnType<typeof readSources>>;
  source: Awaited<ReturnType<typeof readSources>>["subscriptions"][number];
  history: Awaited<ReturnType<typeof readSources>>["history"];
  fx: FxEvidenceCache;
  previousMonthEnd: string;
}): Promise<SubscriptionMetricBase> {
  const { executor, orgId, month, sources, source, history, fx, previousMonthEnd } = args;
  const baseCurrency = sources.baseCurrency;
  const monthEnd = sources.monthEnd;
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
  const normalized = () =>
    monthlyRecurringRevenue(
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
  const mrrEnd = monthStatus === "active" ? mulDecimal(normalized(), mrrEvidence.rate!) : "0.0000";
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
  // Convert predecessor MRR at the prior month-end before movement classification.
  // The conversion evidence is included in the canonical input hash.
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
    priorPositive:
      history.some((row) => cmp(row.mrr_end, "0") > 0) ||
      (source.start_on <= previousMonthEnd &&
        previousStatus !== "active" &&
        monthStatus === "active"),
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
  const rawTermMonths =
    source.renewal_term_months == null
      ? source.term_starts_on && source.term_ends_on
        ? String(
            Math.max(
              1,
              monthOrdinal(monthStartForDate(source.term_ends_on)) -
                monthOrdinal(monthStartForDate(source.term_starts_on)) +
                1,
            ),
          )
        : sources.definitions.evergreenBookingMonths
      : String(source.renewal_term_months);
  const bookedRecurring =
    movement === "new" || movement === "reactivation"
      ? mrrEnd
      : movement === "expansion"
        ? amounts.expansionMrr
        : "0.0000";

  return {
    subsidiaryId,
    sourceCurrency,
    mrrEvidence,
    previousEvidence,
    openingTranslation,
    mrrStart,
    mrrEnd,
    amounts,
    movement,
    rawTermMonths,
    bookedRecurring,
  };
}

async function computeSubscriptionFinancials(args: {
  executor: SqlExecutor;
  orgId: string;
  targetYear: number;
  targetMonth: number;
  sources: Awaited<ReturnType<typeof readSources>>;
  source: Awaited<ReturnType<typeof readSources>>["subscriptions"][number];
  subsidiaryId: string;
  fx: FxEvidenceCache;
}): Promise<{
  recognizedRevenue: string;
  revenueTranslation: Record<string, unknown> | null;
  deferredDelta: string;
  deferredBalance: string;
  deferredTranslation: Record<string, unknown> | null;
}> {
  const { executor, orgId, targetYear, targetMonth, sources, source, subsidiaryId, fx } = args;
  const baseCurrency = sources.baseCurrency;
  const monthEnd = sources.monthEnd;
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

  return {
    recognizedRevenue,
    revenueTranslation,
    deferredDelta,
    deferredBalance,
    deferredTranslation,
  };
}

async function translateLedgerAndBillings(args: {
  executor: SqlExecutor;
  orgId: string;
  targetYear: number;
  targetMonth: number;
  sources: Awaited<ReturnType<typeof readSources>>;
  fx: FxEvidenceCache;
}): Promise<
  Pick<
    MonthlyNormalization,
    "glBySubsidiary" | "billingsBySubsidiary" | "glEvidence" | "billingsEvidence"
  >
> {
  const { executor, orgId, targetYear, targetMonth, sources, fx } = args;
  const baseCurrency = sources.baseCurrency;
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
    glBySubsidiary.set(bucket.subsidiary_id, {
      functionalCurrency: bucket.functional_currency,
      revenue,
      cogs,
    });
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
  // Convert each document leg through its stored posting rate, then the
  // subsidiary's functional-currency monthly average. Reversals reuse the original first leg.
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

  return { glBySubsidiary, billingsBySubsidiary, glEvidence, billingsEvidence };
}

export async function computeRows(
  executor: SqlExecutor,
  orgId: string,
  month: string,
  sources: Awaited<ReturnType<typeof readSources>>,
): Promise<MonthlyNormalization> {
  const historyBySubscription = mapHistory(sources.history);
  const fx: FxEvidenceCache = { asOf: new Map(), monthAverage: new Map() };
  const previousMonthStart = sources.previousMonth;
  const previousBounds = await executor.execute<{ previous_month_end: string }>(
    sql`
    select (${previousMonthStart}::date + interval '1 month - 1 day')::date::text as previous_month_end
  `,
    "objects",
  );
  const previousMonthEnd = previousBounds[0]!.previous_month_end;
  const targetYear = Number(month.slice(0, 4));
  const targetMonth = Number(month.slice(5, 7));
  const rows: MonthlySubscriptionFact[] = [];
  const monthlyEvidence: MonthlyNormalization["monthlyEvidence"] = {};
  const deferredBalanceBySubscription = new Map<string, string>();
  for (const source of sources.subscriptions) {
    const base = await computeSubscriptionBase({
      executor,
      orgId,
      month,
      sources,
      source,
      history: historyBySubscription.get(source.id) ?? [],
      fx,
      previousMonthEnd,
    });
    const financial = await computeSubscriptionFinancials({
      executor,
      orgId,
      targetYear,
      targetMonth,
      sources,
      source,
      subsidiaryId: base.subsidiaryId,
      fx,
    });
    deferredBalanceBySubscription.set(source.id, financial.deferredBalance);
    rows.push({
      orgId,
      subsidiaryId: base.subsidiaryId,
      customerId: source.customer_id,
      subscriptionId: source.id,
      month,
      cohortMonth: monthStartForDate(source.start_on),
      mrrStart: base.mrrStart,
      mrrEnd: base.mrrEnd,
      ...base.amounts,
      movement: base.movement,
      recognizedRevenue: financial.recognizedRevenue,
      deferredDelta: financial.deferredDelta,
      booking: mul(base.bookedRecurring, base.rawTermMonths),
    });
    monthlyEvidence[source.id] = {
      denomination_version: SAAS_METRICS_DENOMINATION_VERSION,
      reporting_currency: sources.baseCurrency,
      billing_subsidiary: base.subsidiaryId,
      mrr: {
        plan_currency: base.sourceCurrency,
        target_month_end: sources.monthEnd,
        month_end_rate: base.mrrEvidence,
        previous_month_end_rate: base.previousEvidence,
        opening: base.openingTranslation,
        mrr_start: base.mrrStart,
        mrr_end: base.mrrEnd,
      },
      recognized_revenue: financial.revenueTranslation,
      deferred: financial.deferredTranslation,
      booking: { term_months: base.rawTermMonths, booked_recurring: base.bookedRecurring },
    };
  }
  const financial = await translateLedgerAndBillings({
    executor,
    orgId,
    targetYear,
    targetMonth,
    sources,
    fx,
  });
  return { rows, monthlyEvidence, ...financial, deferredBalanceBySubscription };
}
