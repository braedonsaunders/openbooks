import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../../platform/db.ts";

/** Stores exact decimal strings so correction proofs compare recorded values without float conversion. */
export type StoredMonthlyRow = {
  id: string;
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
  movement: string;
  recognizedRevenue: string;
  deferredDelta: string;
  inputsHash: string;
  reportingCurrency: string | null;
  denominationVersion: string | null;
  normalizationEvidence: unknown;
};

export type StoredFactsRow = {
  id: string;
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
  basis: string;
  inputsHash: string;
  reportingCurrency: string | null;
  denominationVersion: string | null;
  normalizationEvidence: unknown;
};

export type StoredCohortRow = {
  id: string;
  subsidiaryId: string;
  cohortMonth: string;
  month: string;
  monthsSinceStart: number;
  startMrr: string;
  mrr: string;
  startCustomers: number;
  customers: number;
  inputsHash: string;
  reportingCurrency: string | null;
  denominationVersion: string | null;
  normalizationEvidence: unknown;
};

export interface StoredMetricsMonth {
  monthly: StoredMonthlyRow[];
  facts: StoredFactsRow[];
  cohorts: StoredCohortRow[];
}

/** Read the currently stored row sets for one org and month, in stable order. */
export async function readStoredMetricsMonth(
  executor: SqlExecutor,
  orgId: string,
  month: string,
): Promise<StoredMetricsMonth> {
  const monthly = await executor.execute<StoredMonthlyRow>(
    sql`
    select id::text as id, subsidiary_id::text as "subsidiaryId", customer_id::text as "customerId",
           subscription_id::text as "subscriptionId", month::text as month, cohort_month::text as "cohortMonth",
           mrr_start::text as "mrrStart", mrr_end::text as "mrrEnd",
           new_mrr::text as "newMrr", expansion_mrr::text as "expansionMrr",
           contraction_mrr::text as "contractionMrr", churned_mrr::text as "churnedMrr",
           reactivation_mrr::text as "reactivationMrr", movement,
           recognized_revenue::text as "recognizedRevenue", deferred_delta::text as "deferredDelta",
           inputs_hash as "inputsHash", reporting_currency as "reportingCurrency",
           denomination_version as "denominationVersion", normalization_evidence as "normalizationEvidence"
      from saas_metrics_monthly
     where org_id = ${orgId} and month = ${month}::date
     order by subscription_id
  `,
    "objects",
  );
  const facts = await executor.execute<StoredFactsRow>(
    sql`
    select id::text as id, subsidiary_id::text as "subsidiaryId", month::text as month,
           mrr_start::text as "mrrStart", mrr_end::text as "mrrEnd",
           new_mrr::text as "newMrr", expansion_mrr::text as "expansionMrr",
           contraction_mrr::text as "contractionMrr", churned_mrr::text as "churnedMrr",
           reactivation_mrr::text as "reactivationMrr",
           recognized_revenue::text as "recognizedRevenue", deferred_delta::text as "deferredDelta",
           mrr_at_risk::text as "mrrAtRisk",
           customers_start as "customersStart", customers_end as "customersEnd",
           customers_new as "customersNew", customers_churned as "customersChurned",
           customers_reactivated as "customersReactivated",
           gl_revenue::text as "glRevenue", gl_cogs::text as "glCogs",
           bookings::text as bookings, billings::text as billings,
           deferred_balance::text as "deferredBalance", basis,
           inputs_hash as "inputsHash", reporting_currency as "reportingCurrency",
           denomination_version as "denominationVersion", normalization_evidence as "normalizationEvidence"
      from saas_metrics_facts_monthly
     where org_id = ${orgId} and month = ${month}::date
     order by subsidiary_id
  `,
    "objects",
  );
  const cohorts = await executor.execute<StoredCohortRow>(
    sql`
    select id::text as id, subsidiary_id::text as "subsidiaryId",
           cohort_month::text as "cohortMonth", month::text as month,
           months_since_start as "monthsSinceStart",
           start_mrr::text as "startMrr", mrr::text as mrr,
           start_customers as "startCustomers", customers,
           inputs_hash as "inputsHash", reporting_currency as "reportingCurrency",
           denomination_version as "denominationVersion", normalization_evidence as "normalizationEvidence"
      from saas_metrics_cohort_monthly
     where org_id = ${orgId} and month = ${month}::date
     order by subsidiary_id, cohort_month
  `,
    "objects",
  );
  return { monthly, facts, cohorts };
}
