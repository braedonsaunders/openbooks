import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../../platform/db.ts";
import {
  normalizationInputsHash,
  SAAS_METRICS_DENOMINATION_VERSION,
} from "./metrics-normalization.ts";
import { refusal } from "./metrics-ledger-calculation.ts";
import type { MonthlySubscriptionFact } from "./metrics-ledger-calculation.ts";
import { readSources } from "./metrics-ledger-source-reading.ts";
import { computeRows } from "./metrics-ledger-month-computation.ts";
import type { MonthlyNormalization } from "./metrics-ledger-month-computation.ts";
import { aggregateCohorts, aggregateFacts } from "./metrics-ledger-aggregation.ts";
import type { CohortFact, FactsRow } from "./metrics-ledger-aggregation.ts";

async function writeMonthlyRow(
  executor: SqlExecutor,
  row: MonthlySubscriptionFact,
  reportingCurrency: string,
  evidence: Record<string, unknown>,
  inputsHash: string,
): Promise<void> {
  const result = await executor.execute<{ id: string }>(
    sql`
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
  `,
    "objects",
  );
  if (result.length !== 1)
    throw refusal(
      "saas_metrics_subscription_write_missing",
      `Metrics for subscription ${row.subscriptionId} were not stored.`,
      "Retry the recompute after confirming that the subscription remains in the organization.",
    );
}

async function writeFactsRow(
  executor: SqlExecutor,
  orgId: string,
  row: FactsRow,
  reportingCurrency: string,
  evidence: Record<string, unknown>,
  inputsHash: string,
): Promise<void> {
  const result = await executor.execute<{ id: string }>(
    sql`
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
  `,
    "objects",
  );
  if (result.length !== 1)
    throw refusal(
      "saas_metrics_facts_write_missing",
      `Monthly facts for subsidiary ${row.subsidiaryId} were not stored.`,
      "Retry the recompute after confirming that the subsidiary remains active.",
    );
}

async function writeCohortRow(
  executor: SqlExecutor,
  orgId: string,
  row: CohortFact,
  reportingCurrency: string,
  evidence: Record<string, unknown>,
  inputsHash: string,
): Promise<void> {
  const result = await executor.execute<{ id: string }>(
    sql`
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
  `,
    "objects",
  );
  if (result.length !== 1)
    throw refusal(
      "saas_metrics_cohort_write_missing",
      `Cohort facts for subsidiary ${row.subsidiaryId} and cohort ${row.cohortMonth} were not stored.`,
      "Retry the recompute after confirming that the cohort remains in the organization.",
    );
}

/** Computes one normalized month; callers own the open-period or approved-correction write policy. */
export interface NormalizedMetricsMonth {
  subsidiaryIds: string[];
  reportingCurrency: string;
  computed: MonthlyNormalization;
  facts: FactsRow[];
  cohorts: CohortFact[];
  factsEvidence: Record<string, Record<string, unknown>>;
  cohortsEvidence: Record<string, unknown>[];
  monthHash: string;
}

/** Run the v1 computation and evidence assembly for one org and month. */
export async function computeNormalizedMetricsMonth(
  executor: SqlExecutor,
  orgId: string,
  month: string,
): Promise<NormalizedMetricsMonth> {
  const sources = await readSources(executor, orgId, month);
  const reportingCurrency = sources.baseCurrency;
  const computed = await computeRows(executor, orgId, month, sources);
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
  const cohorts = await aggregateCohorts(
    executor,
    orgId,
    reportingCurrency,
    month,
    computed.rows,
    sources.history,
    sources.cohortStartRows,
  );
  // Hash canonical inputs and evidence once; every output row stores that digest.
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
      .filter(
        (row) => row.subsidiaryId === cohort.subsidiaryId && row.cohortMonth === cohort.cohortMonth,
      )
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
  return {
    subsidiaryIds: sources.subsidiaries.map((row) => row.id),
    reportingCurrency,
    computed,
    facts,
    cohorts,
    factsEvidence,
    cohortsEvidence,
    monthHash,
  };
}

/** Stores one month and refuses if a required row is not written. */
export async function writeNormalizedMetricsMonth(
  executor: SqlExecutor,
  orgId: string,
  normalized: NormalizedMetricsMonth,
): Promise<{ subscriptionRows: number; subsidiaryRows: number }> {
  for (const row of normalized.computed.rows) {
    await writeMonthlyRow(
      executor,
      row,
      normalized.reportingCurrency,
      {
        ...normalized.computed.monthlyEvidence[row.subscriptionId]!,
        inputs_hash: normalized.monthHash,
      },
      normalized.monthHash,
    );
  }
  for (const row of normalized.facts) {
    await writeFactsRow(
      executor,
      orgId,
      row,
      normalized.reportingCurrency,
      {
        ...normalized.factsEvidence[row.subsidiaryId]!,
        inputs_hash: normalized.monthHash,
      },
      normalized.monthHash,
    );
  }
  for (const [index, row] of normalized.cohorts.entries()) {
    await writeCohortRow(
      executor,
      orgId,
      row,
      normalized.reportingCurrency,
      {
        ...normalized.cohortsEvidence[index]!,
        inputs_hash: normalized.monthHash,
      },
      normalized.monthHash,
    );
  }
  return {
    subscriptionRows: normalized.computed.rows.length,
    subsidiaryRows: normalized.facts.length,
  };
}
