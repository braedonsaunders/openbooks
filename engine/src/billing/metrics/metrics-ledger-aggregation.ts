import { cmp, mulDecimal } from "../../money/money.ts";
import { type FxAsOfEvidence } from "../../fx/spot-rate.ts";
import { type SqlExecutor } from "../../platform/db.ts";
import {
  asOfEvidence,
  moneySum,
  monthEndFor,
  monthOrdinal,
  refusal,
  validatedHistoryCurrency,
} from "./metrics-ledger-calculation.ts";
import type {
  FxEvidenceCache,
  HistoryRow,
  MonthlySubscriptionFact,
} from "./metrics-ledger-calculation.ts";
import { readSources } from "./metrics-ledger-source-reading.ts";

export type FactsRow = {
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

export function aggregateFacts(
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
  const historyLive = new Set(
    history
      .filter((row) => cmp(row.mrr_end, "0") > 0)
      .map((row) => `${row.subsidiary_id}:${row.customer_id}`),
  );
  const facts: FactsRow[] = [];
  for (const subsidiaryId of subsidiaryIds) {
    const scoped = rows.filter((row) => row.subsidiaryId === subsidiaryId);
    const customersStart = new Set(
      scoped.filter((row) => cmp(row.mrrStart, "0") > 0).map((row) => row.customerId),
    );
    const customersEnd = new Set(
      scoped.filter((row) => cmp(row.mrrEnd, "0") > 0).map((row) => row.customerId),
    );
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
      deferredBalance: moneySum(
        scoped.map((row) => deferredBalanceBySubscription.get(row.subscriptionId) ?? "0.0000"),
      ),
      basis,
    });
  }
  return facts;
}

export type CohortFact = {
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

export async function aggregateCohorts(
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
  // Convert persisted openings at cohort month-end; customer counts remain unchanged.
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
    const storedStart = cohortStarts.find(
      (row) => row.subsidiary_id === subsidiaryId && row.cohort_month.slice(0, 10) === cohortMonth,
    );
    const historicalStartRows = history.filter(
      (row) =>
        row.subsidiary_id === subsidiaryId &&
        row.month.slice(0, 10) === cohortMonth &&
        row.cohort_month.slice(0, 10) === cohortMonth,
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
      startCustomers = new Set(
        cohortRows.filter((row) => cmp(row.mrrEnd, "0") > 0).map((row) => row.customerId),
      ).size;
      opening = {
        source: "opening",
        cohort_month: cohortMonth,
        start_mrr: startMrr,
        start_customers: startCustomers,
      };
    } else {
      const converted = await Promise.all(
        historicalStartRows.map(async (row) =>
          normalizeOpening({
            subsidiaryId,
            cohortMonth,
            rawAmount: row.mrr_end,
            reportingCurrency: row.reporting_currency,
            denominationVersion: row.denomination_version,
            scope: `Subscription ${row.subscription_id} opening-month MRR for ${cohortMonth}`,
          }),
        ),
      );
      startMrr = moneySum(converted.map((entry) => entry.amount));
      startCustomers = new Set(
        historicalStartRows
          .filter((row) => cmp(row.mrr_end, "0") > 0)
          .map((row) => row.customer_id),
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
      customers: new Set(
        cohortRows.filter((row) => cmp(row.mrrEnd, "0") > 0).map((row) => row.customerId),
      ).size,
      opening,
    });
  }
  return facts;
}
