import { sql } from "drizzle-orm";
import { orgFeatureEnabled } from "../../organization/org-feature-lock.ts";
import { excludePeriodEndJournals } from "../../records/period-end-origins.ts";
import { type SqlExecutor } from "../../platform/db.ts";
import { saasMetricsDefinitions } from "./metrics-ledger-definitions.ts";
import type { SaasMetricsDefinitions } from "./metrics-ledger-definitions.ts";
import { refusal } from "./metrics-ledger-calculation.ts";
import type {
  BillingLeg,
  DeferredBucket,
  HistoryRow,
  LedgerBucket,
  RevenueBucket,
  SubscriptionSource,
  SubsidiaryRow,
} from "./metrics-ledger-calculation.ts";

type SourceContext = {
  monthEnd: string;
  previousMonth: string;
  baseCurrency: string;
  definitions: SaasMetricsDefinitions;
  subsidiaries: SubsidiaryRow[];
  subscriptions: SubscriptionSource[];
  history: HistoryRow[];
  revenueRecognitionEnabled: boolean;
};

async function readSourceContext(
  executor: SqlExecutor,
  orgId: string,
  month: string,
): Promise<SourceContext> {
  const bounds = await executor.execute<{ month_end: string; previous_month: string }>(
    sql`
    select (${month}::date + interval '1 month - 1 day')::date::text as month_end,
           (${month}::date - interval '1 month')::date::text as previous_month
  `,
    "objects",
  );
  const monthEnd = bounds[0]!.month_end;
  const previousMonth = bounds[0]!.previous_month;
  const org = (
    await executor.execute<{ base_currency: string; settings: unknown }>(
      sql`
    select base_currency, settings from orgs where id = ${orgId}
  `,
      "objects",
    )
  )[0];
  if (!org)
    throw refusal(
      "saas_metrics_org_missing",
      "The organization no longer exists.",
      "Select an active organization and run the metrics recompute again.",
    );
  const definitions = saasMetricsDefinitions(orgId, org.settings);
  const subsidiaries = await executor.execute<SubsidiaryRow>(
    sql`
    select id, base_currency from subsidiaries where org_id = ${orgId} and is_active and not is_elimination order by id
  `,
    "objects",
  );
  const subscriptions = await executor.execute<SubscriptionSource>(
    sql`
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
  `,
    "objects",
  );
  const subscriptionIds = subscriptions.map((row) => row.id);
  let history: HistoryRow[] = [];
  if (subscriptionIds.length > 0) {
    history = await executor.execute<HistoryRow>(
      sql`
      select subscription_id, customer_id, subsidiary_id, month::text, cohort_month::text, mrr_end::text,
             reporting_currency, denomination_version
        from saas_metrics_monthly
       where org_id = ${orgId} and month < ${month}::date
         and subscription_id in (${sql.join(
           subscriptionIds.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
       order by subscription_id, month
    `,
      "objects",
    );
  }
  const revenueRecognitionEnabled = await orgFeatureEnabled(orgId, "revenueRecognition", executor);
  return {
    monthEnd,
    previousMonth,
    baseCurrency: org.base_currency,
    definitions,
    subsidiaries,
    subscriptions,
    history,
    revenueRecognitionEnabled,
  };
}

async function readRevenueAndDeferredBuckets(
  executor: SqlExecutor,
  orgId: string,
  month: string,
  revenueRecognitionEnabled: boolean,
): Promise<{ revenueBuckets: RevenueBucket[]; deferredBuckets: DeferredBucket[] }> {
  // Journal amounts below are subsidiary-functional, never org-base: each
  // bucket keeps its functional currency so translation happens per legal
  // entity against month evidence, before any sum.
  const revenueBuckets = await executor.execute<RevenueBucket>(
    sql`
    with source_documents as (
      select d.id, d.posted_entry_id, d.reversal_entry_id, s.id as subscription_id
        from documents d
        join subscriptions s on s.org_id = d.org_id
         and (d.subscription_id = s.id or d.custom->>'subscriptionId' = s.id::text)
       where d.org_id = ${orgId} and d.kind in ('customer_invoice', 'customer_credit', 'cash_sale', 'cash_refund')
         and d.status in ('posted', 'voided')
    ), entries as (
      select subscription_id, posted_entry_id as entry_id from source_documents
       where posted_entry_id is not null
      union
      select subscription_id, reversal_entry_id from source_documents
       where reversal_entry_id is not null
      ${
        revenueRecognitionEnabled
          ? sql`union
      select s.id as subscription_id, posted.entry_id
        from subscriptions s
        join documents d on d.org_id = s.org_id and (d.subscription_id = s.id or d.custom->>'subscriptionId' = s.id::text)
        join document_lines dl on dl.org_id = d.org_id and dl.document_id = d.id
        join performance_obligations po on po.org_id = dl.org_id and po.document_line_id = dl.id
        join recognition_schedules rs on rs.org_id = po.org_id and rs.obligation_id = po.id
        join recognition_schedule_lines rsl on rsl.org_id = rs.org_id and rsl.schedule_id = rs.id
        cross join lateral (values (rsl.journal_entry_id), (rsl.reversal_journal_entry_id)) posted(entry_id)
       where s.org_id = ${orgId} and d.kind in ('customer_invoice', 'customer_credit', 'cash_sale', 'cash_refund')
         and d.status in ('posted', 'voided') and posted.entry_id is not null`
          : sql``
      }
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
  `,
    "objects",
  );
  const deferredBuckets = await executor.execute<DeferredBucket>(
    sql`
    with subscription_obligations as (
      select distinct s.id as subscription_id, po.id as obligation_id,
             coalesce(po.deferred_account_id, rr.deferred_account_id) as deferred_account_id
        from subscriptions s
        join documents d on d.org_id = s.org_id and (d.subscription_id = s.id or d.custom->>'subscriptionId' = s.id::text)
        join document_lines dl on dl.org_id = d.org_id and dl.document_id = d.id
        join performance_obligations po on po.org_id = dl.org_id and po.document_line_id = dl.id
        join recognition_rules rr on rr.org_id = po.org_id and rr.id = po.recognition_rule_id
       where s.org_id = ${orgId} and d.kind in ('customer_invoice', 'customer_credit', 'cash_sale', 'cash_refund')
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
  `,
    "objects",
  );

  return { revenueBuckets, deferredBuckets };
}

async function readLedgerAndBillingBuckets(
  executor: SqlExecutor,
  orgId: string,
  month: string,
  definitions: SaasMetricsDefinitions,
): Promise<{ ledgerBuckets: LedgerBucket[]; billingLegs: BillingLeg[] }> {
  const ledgerBuckets = await executor.execute<LedgerBucket>(
    sql`
    select l.subsidiary_id, sub.base_currency as functional_currency,
           coalesce(sum(-l.amount) filter (where a.type in ('income', 'income_other')), 0)::text as revenue,
           coalesce(sum(l.amount) filter (where a.type = 'cogs'), 0)::text as cogs
      from journal_entries e
      join accounting_books b on b.org_id = e.org_id and b.id = e.book_id and b.is_primary and b.is_active and b.posts_gl
      join journal_lines l on l.org_id = e.org_id and l.entry_id = e.id
      join accounts a on a.org_id = l.org_id and a.id = l.account_id
      join subsidiaries sub on sub.org_id = e.org_id and sub.id = l.subsidiary_id
     where e.org_id = ${orgId} and e.status in ('posted', 'reversed')
       and ${excludePeriodEndJournals(sql`e.origin`)}
       and e.posting_date >= ${month}::date and e.posting_date < (${month}::date + interval '1 month')
     group by l.subsidiary_id, sub.base_currency
     order by l.subsidiary_id
  `,
    "objects",
  );
  const billingsBaseAmount = definitions.billingsUsePreTaxSubtotal ? sql`d.subtotal` : sql`d.total`;
  const billingsAmount = definitions.customerCreditsReduceBillings
    ? sql`case when d.kind in ('customer_credit', 'cash_refund') then -${billingsBaseAmount} else ${billingsBaseAmount} end`
    : billingsBaseAmount;
  // Preserve each posted or reversal leg and its stored rate for conversion before aggregation.
  const billingLegs = await executor.execute<BillingLeg>(
    sql`
    with billing_legs as (
      select d.id as document_id, d.org_id, d.subsidiary_id, d.currency as txn_currency,
             d.fx_rate::text as stored_fx_rate, ${billingsAmount} as txn_amount,
             d.document_date as effective_date, 'posted' as leg
        from documents d
       where d.org_id = ${orgId} and d.kind in ('customer_invoice', 'customer_credit', 'cash_sale', 'cash_refund')
         and d.status in ('posted', 'voided') and d.posted_entry_id is not null
      union all
      select d.id as document_id, d.org_id, d.subsidiary_id, d.currency as txn_currency,
             d.fx_rate::text as stored_fx_rate, -(${billingsAmount}) as txn_amount,
             reversal.posting_date as effective_date, 'reversal' as leg
        from documents d
        join journal_entries reversal
          on reversal.org_id = d.org_id and reversal.id = d.reversal_entry_id
         and reversal.status in ('posted', 'reversed')
       where d.org_id = ${orgId} and d.kind in ('customer_invoice', 'customer_credit', 'cash_sale', 'cash_refund')
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
  `,
    "objects",
  );

  return { ledgerBuckets, billingLegs };
}

async function readCohortStartRows(
  executor: SqlExecutor,
  orgId: string,
  month: string,
): Promise<
  Array<{
    subsidiary_id: string;
    cohort_month: string;
    start_mrr: string;
    start_customers: number;
    reporting_currency: string | null;
    denomination_version: string | null;
  }>
> {
  // The month being computed supplies its own cohort opening from current
  // subscription facts. Only earlier openings are persisted inputs; reading
  // this month's output would change its hash on an unchanged recompute.
  const cohortStartRows = await executor.execute<{
    subsidiary_id: string;
    cohort_month: string;
    start_mrr: string;
    start_customers: number;
    reporting_currency: string | null;
    denomination_version: string | null;
  }>(
    sql`
    select subsidiary_id, cohort_month::text, start_mrr::text, start_customers,
           reporting_currency, denomination_version
      from saas_metrics_cohort_monthly
     where org_id = ${orgId} and month = cohort_month and cohort_month < ${month}::date
     order by subsidiary_id, cohort_month
  `,
    "objects",
  );

  return cohortStartRows;
}

export async function readSources(
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
  const context = await readSourceContext(executor, orgId, month);
  const journal = await readRevenueAndDeferredBuckets(
    executor,
    orgId,
    month,
    context.revenueRecognitionEnabled,
  );
  const financial = await readLedgerAndBillingBuckets(executor, orgId, month, context.definitions);
  const cohortStartRows = await readCohortStartRows(executor, orgId, month);
  return { ...context, ...journal, ...financial, cohortStartRows };
}

export function mapHistory(history: HistoryRow[]) {
  const bySubscription = new Map<string, HistoryRow[]>();
  for (const row of history)
    bySubscription.set(row.subscription_id, [
      ...(bySubscription.get(row.subscription_id) ?? []),
      row,
    ]);
  return bySubscription;
}
