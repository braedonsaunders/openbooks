import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { add, cmp, mul, mulDecimal, neg } from "../../money/money.ts";
import { orgFeatureEnabled } from "../../organization/org-feature-lock.ts";
import { excludePeriodEndJournals } from "../../records/period-end-origins.ts";
import { type SqlExecutor } from "../../platform/db.ts";
import { monthlyRecurringRevenue } from "../subscription-billing.ts";
import { saasMetricsDefinitions } from "./metrics-ledger-definitions.ts";
import type { SaasMetricsDefinitions } from "./metrics-ledger-definitions.ts";
import {
  chooseMovement,
  moneySum,
  monthOrdinal,
  monthStartForDate,
  movementAmounts,
  refusal,
  statusAtMonthEnd,
} from "./metrics-ledger-calculation.ts";
import type {
  HistoryRow,
  MonthlySubscriptionFact,
  SubscriptionSource,
} from "./metrics-ledger-calculation.ts";
import { mapHistory } from "./metrics-ledger-source-reading.ts";
import type { FactsRow } from "./metrics-ledger-aggregation.ts";
import {
  legacyPriorProvenance,
  legacySpotRate,
  provenanceRefusal,
} from "./metrics-ledger-legacy-provenance.ts";
import type {
  LegacyBillingRow,
  LegacyCohortStartRow,
  LegacyDeferredRow,
  LegacyHistoryRow,
  LegacyLedgerRow,
  LegacyRevenueRow,
  ValidatedPriorMonth,
} from "./metrics-ledger-legacy-provenance.ts";

type LegacySourceContext = {
  monthEnd: string;
  previousMonth: string;
  baseCurrency: string;
  definitions: SaasMetricsDefinitions;
  subsidiaries: Array<{ id: string }>;
  subscriptions: SubscriptionSource[];
  history: LegacyHistoryRow[];
  revenueRecognitionEnabled: boolean;
};

async function readLegacySourceContext(
  executor: SqlExecutor,
  orgId: string,
  month: string,
): Promise<LegacySourceContext> {
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
  const subsidiaries = await executor.execute<{ id: string }>(
    sql`
    select id from subsidiaries where org_id = ${orgId} and is_active and not is_elimination order by id
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
  let history: LegacyHistoryRow[] = [];
  if (subscriptionIds.length > 0) {
    history = await executor.execute<LegacyHistoryRow>(
      sql`
      select subscription_id, customer_id, subsidiary_id, month::text, cohort_month::text, mrr_end::text,
             reporting_currency
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
    // Corrected history is reconstructed only from validated audit before-images.
    if (history.some((row) => row.reporting_currency !== null)) {
      const priorCache = new Map<string, ValidatedPriorMonth>();
      const priorOf = async (prior: string): Promise<ValidatedPriorMonth> => {
        let validated = priorCache.get(prior);
        if (!validated) {
          validated = await legacyPriorProvenance(executor, orgId, prior, month);
          priorCache.set(prior, validated);
        }
        return validated;
      };
      const substituted: LegacyHistoryRow[] = [];
      for (const row of history) {
        if (row.reporting_currency === null) {
          substituted.push(row);
          continue;
        }
        const priorMonth = row.month.slice(0, 10);
        const prior = await priorOf(priorMonth);
        const legacyRow = prior.monthly.get(row.subscription_id);
        if (!legacyRow) {
          throw provenanceRefusal(
            "tampered",
            `saas_metrics_monthly:${row.subscription_id}:${priorMonth}`,
            month,
          );
        }
        substituted.push(legacyRow);
      }
      history = substituted;
    }
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

async function readLegacyRevenueAndDeferred(
  executor: SqlExecutor,
  orgId: string,
  month: string,
  revenueRecognitionEnabled: boolean,
): Promise<{ revenueRows: LegacyRevenueRow[]; deferredRows: LegacyDeferredRow[] }> {
  const revenueRows = await executor.execute<LegacyRevenueRow>(
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
    select e.subscription_id, coalesce(sum(-l.amount) filter (where a.type in ('income', 'income_other')), 0)::text as revenue
      from entries e
      join journal_entries je on je.org_id = ${orgId} and je.id = e.entry_id and je.status in ('posted', 'reversed')
      join accounting_books b on b.org_id = je.org_id and b.id = je.book_id and b.is_primary and b.is_active and b.posts_gl
      join journal_lines l on l.org_id = je.org_id and l.entry_id = je.id
      join accounts a on a.org_id = l.org_id and a.id = l.account_id
     where je.posting_date >= ${month}::date
       and je.posting_date < (${month}::date + interval '1 month')
     group by e.subscription_id
  `,
    "objects",
  );
  const deferredRows = await executor.execute<LegacyDeferredRow>(
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
    select e.subscription_id,
           coalesce(sum(-l.amount) filter (where je.posting_date >= ${month}::date and je.posting_date < (${month}::date + interval '1 month')), 0)::text as deferred_delta,
           coalesce(sum(-l.amount) filter (where je.posting_date < (${month}::date + interval '1 month')), 0)::text as deferred_balance
      from entries e
      join journal_entries je on je.org_id = ${orgId} and je.id = e.entry_id and je.status in ('posted', 'reversed')
      join accounting_books b on b.org_id = je.org_id and b.id = je.book_id and b.is_primary and b.is_active and b.posts_gl
      join journal_lines l on l.org_id = je.org_id and l.entry_id = je.id and l.account_id = e.deferred_account_id
     where je.posting_date < (${month}::date + interval '1 month')
     group by e.subscription_id
  `,
    "objects",
  );

  return { revenueRows, deferredRows };
}

async function readLegacyLedgerAndBillings(
  executor: SqlExecutor,
  orgId: string,
  month: string,
  definitions: SaasMetricsDefinitions,
): Promise<{ ledgerRows: LegacyLedgerRow[]; billingRows: LegacyBillingRow[] }> {
  const ledgerRows = await executor.execute<LegacyLedgerRow>(
    sql`
    select l.subsidiary_id,
           coalesce(sum(-l.amount) filter (where a.type in ('income', 'income_other')), 0)::text as revenue,
           coalesce(sum(l.amount) filter (where a.type = 'cogs'), 0)::text as cogs
      from journal_entries e
      join accounting_books b on b.org_id = e.org_id and b.id = e.book_id and b.is_primary and b.is_active and b.posts_gl
      join journal_lines l on l.org_id = e.org_id and l.entry_id = e.id
      join accounts a on a.org_id = l.org_id and a.id = l.account_id
     where e.org_id = ${orgId} and e.status in ('posted', 'reversed')
       and ${excludePeriodEndJournals(sql`e.origin`)}
       and e.posting_date >= ${month}::date and e.posting_date < (${month}::date + interval '1 month')
     group by l.subsidiary_id
  `,
    "objects",
  );
  const billingsBaseAmount = definitions.billingsUsePreTaxSubtotal ? sql`d.subtotal` : sql`d.total`;
  const billingsAmount = definitions.customerCreditsReduceBillings
    ? sql`case when d.kind in ('customer_credit', 'cash_refund') then -${billingsBaseAmount} else ${billingsBaseAmount} end`
    : billingsBaseAmount;
  const billingRows = await executor.execute<LegacyBillingRow>(
    sql`
    with billing_entries as (
      select d.org_id, d.subsidiary_id, d.document_date as effective_date, ${billingsAmount} as amount
        from documents d
       where d.org_id = ${orgId} and d.kind in ('customer_invoice', 'customer_credit', 'cash_sale', 'cash_refund')
         and d.status in ('posted', 'voided') and d.posted_entry_id is not null
      union all
      select d.org_id, d.subsidiary_id, reversal.posting_date as effective_date, -(${billingsAmount}) as amount
        from documents d
        join journal_entries reversal
          on reversal.org_id = d.org_id and reversal.id = d.reversal_entry_id
         and reversal.status in ('posted', 'reversed')
       where d.org_id = ${orgId} and d.kind in ('customer_invoice', 'customer_credit', 'cash_sale', 'cash_refund')
         and d.status = 'voided' and d.posted_entry_id is not null
    )
    select coalesce(billing.subsidiary_id, (select id from subsidiaries where org_id = billing.org_id and parent_id is null)) as subsidiary_id,
           coalesce(sum(billing.amount), 0)::text as billings
      from billing_entries billing
     where billing.effective_date >= ${month}::date
       and billing.effective_date < (${month}::date + interval '1 month')
     group by 1
  `,
    "objects",
  );

  return { ledgerRows, billingRows };
}

async function readLegacyCohortStarts(
  executor: SqlExecutor,
  orgId: string,
  month: string,
): Promise<LegacyCohortStartRow[]> {
  const storedStarts = await executor.execute<LegacyCohortStartRow>(
    sql`
    select subsidiary_id, cohort_month::text, start_mrr::text, start_customers, reporting_currency
      from saas_metrics_cohort_monthly
     where org_id = ${orgId} and month = cohort_month and cohort_month <= ${month}::date
  `,
    "objects",
  );
  // Corrected cohort openings are reconstructed only from validated audit before-images.
  let cohortStartRows: LegacyCohortStartRow[] = storedStarts;
  if (storedStarts.some((row) => row.reporting_currency !== null)) {
    const priorCache = new Map<string, ValidatedPriorMonth>();
    const priorOf = async (prior: string): Promise<ValidatedPriorMonth> => {
      let validated = priorCache.get(prior);
      if (!validated) {
        validated = await legacyPriorProvenance(executor, orgId, prior, month);
        priorCache.set(prior, validated);
      }
      return validated;
    };
    const substituted: LegacyCohortStartRow[] = [];
    for (const row of storedStarts) {
      if (row.reporting_currency === null) {
        substituted.push(row);
        continue;
      }
      const cohortMonth = row.cohort_month.slice(0, 10);
      const prior = await priorOf(cohortMonth);
      const legacyStart = prior.starts.get(row.subsidiary_id);
      if (!legacyStart) {
        throw provenanceRefusal(
          "tampered",
          `saas_metrics_cohort_monthly:${row.subsidiary_id}:${cohortMonth}`,
          month,
        );
      }
      substituted.push(legacyStart);
    }
    cohortStartRows = substituted;
  }

  return cohortStartRows;
}

async function legacyReadSources(
  executor: SqlExecutor,
  orgId: string,
  month: string,
): Promise<{
  monthEnd: string;
  previousMonth: string;
  baseCurrency: string;
  definitions: SaasMetricsDefinitions;
  subsidiaries: Array<{ id: string }>;
  subscriptions: SubscriptionSource[];
  history: LegacyHistoryRow[];
  revenueRecognitionEnabled: boolean;
  revenueRows: LegacyRevenueRow[];
  deferredRows: LegacyDeferredRow[];
  ledgerRows: LegacyLedgerRow[];
  billingRows: LegacyBillingRow[];
  cohortStartRows: Array<{
    subsidiary_id: string;
    cohort_month: string;
    start_mrr: string;
    start_customers: number;
  }>;
}> {
  const context = await readLegacySourceContext(executor, orgId, month);
  const revenue = await readLegacyRevenueAndDeferred(
    executor,
    orgId,
    month,
    context.revenueRecognitionEnabled,
  );
  const ledger = await readLegacyLedgerAndBillings(executor, orgId, month, context.definitions);
  const cohortStartRows = await readLegacyCohortStarts(executor, orgId, month);
  return { ...context, ...revenue, ...ledger, cohortStartRows };
}

async function legacyComputeRows(
  executor: SqlExecutor,
  orgId: string,
  month: string,
  sources: Awaited<ReturnType<typeof legacyReadSources>>,
): Promise<{ rows: MonthlySubscriptionFact[]; rates: Record<string, string> }> {
  const historyBySubscription = mapHistory(sources.history as unknown as HistoryRow[]);
  const revenueBySubscription = new Map(
    sources.revenueRows.map((row) => [row.subscription_id, row.revenue]),
  );
  const deferredBySubscription = new Map(
    sources.deferredRows.map((row) => [row.subscription_id, row]),
  );
  const rates: Record<string, string> = {};
  const monthEnd = sources.monthEnd;
  const previousMonthStart = sources.previousMonth;
  const previousBounds = await executor.execute<{ previous_month_end: string }>(
    sql`
    select (${previousMonthStart}::date + interval '1 month - 1 day')::date::text as previous_month_end
  `,
    "objects",
  );
  const previousMonthEnd = previousBounds[0]!.previous_month_end;
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
    const normalized = () =>
      monthlyRecurringRevenue(
        source.price_override ?? source.plan_amount,
        source.interval,
        source.interval_count,
        source.quantity,
      );
    const rateOn = async (date: string): Promise<string> => {
      const key = `${sourceCurrency}:${date}`;
      if (!rates[key])
        rates[key] = await legacySpotRate(
          executor,
          orgId,
          sourceCurrency,
          sources.baseCurrency,
          date,
        );
      return rates[key]!;
    };
    const mrrEnd =
      monthStatus === "active" ? mulDecimal(normalized(), await rateOn(monthEnd)) : "0.0000";
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

function legacyAggregateFacts(
  month: string,
  subsidiaryIds: string[],
  rows: MonthlySubscriptionFact[],
  history: LegacyHistoryRow[],
  ledgerRows: LegacyLedgerRow[],
  billingRows: LegacyBillingRow[],
  deferredRows: LegacyDeferredRow[],
  basis: FactsRow["basis"],
): FactsRow[] {
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
      glRevenue: ledgerRows.find((row) => row.subsidiary_id === subsidiaryId)?.revenue ?? "0.0000",
      glCogs: ledgerRows.find((row) => row.subsidiary_id === subsidiaryId)?.cogs ?? "0.0000",
      bookings: moneySum(scoped.map((row) => row.booking)),
      billings: billingRows.find((row) => row.subsidiary_id === subsidiaryId)?.billings ?? "0.0000",
      deferredBalance: moneySum(
        scoped.map(
          (row) =>
            deferredRows.find((r) => r.subscription_id === row.subscriptionId)?.deferred_balance ??
            "0.0000",
        ),
      ),
      basis,
    });
  }
  return facts;
}

function legacyAggregateCohorts(
  month: string,
  rows: MonthlySubscriptionFact[],
  history: LegacyHistoryRow[],
  cohortStarts: Awaited<ReturnType<typeof legacyReadSources>>["cohortStartRows"],
): LegacyV0CohortRow[] {
  const groups = new Map<string, MonthlySubscriptionFact[]>();
  for (const row of rows) {
    const key = `${row.subsidiaryId}:${row.cohortMonth}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, cohortRows]) => {
    const separator = key.indexOf(":");
    const subsidiaryId = key.slice(0, separator);
    const cohortMonth = key.slice(separator + 1);
    // The opening month's values must be proved from subscription inputs,
    // never vouched for by the output row that is being verified.
    const storedStart =
      cohortMonth < month
        ? cohortStarts.find(
            (row) =>
              row.subsidiary_id === subsidiaryId && row.cohort_month.slice(0, 10) === cohortMonth,
          )
        : undefined;
    const historicalStartRows = history.filter(
      (row) =>
        row.subsidiary_id === subsidiaryId &&
        row.month.slice(0, 10) === cohortMonth &&
        row.cohort_month.slice(0, 10) === cohortMonth,
    );
    const startMrr =
      storedStart?.start_mrr ??
      (cohortMonth === month
        ? moneySum(cohortRows.map((row) => row.mrrEnd))
        : moneySum(historicalStartRows.map((row) => row.mrr_end)));
    const startCustomers =
      storedStart?.start_customers ??
      new Set(
        cohortMonth === month
          ? cohortRows.filter((row) => cmp(row.mrrEnd, "0") > 0).map((row) => row.customerId)
          : historicalStartRows
              .filter((row) => cmp(row.mrr_end, "0") > 0)
              .map((row) => row.customer_id),
      ).size;
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
      customers: new Set(
        cohortRows.filter((row) => cmp(row.mrrEnd, "0") > 0).map((row) => row.customerId),
      ).size,
    };
  });
}

/** The v0 digest: plain stringify over the exact v0 payload, one hash for all three row sets. */
function legacyInputsHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export interface LegacyV0CohortRow {
  subsidiaryId: string;
  cohortMonth: string;
  month: string;
  monthsSinceStart: number;
  startMrr: string;
  mrr: string;
  startCustomers: number;
  customers: number;
}

export interface LegacyV0Month {
  monthly: MonthlySubscriptionFact[];
  facts: FactsRow[];
  cohorts: LegacyV0CohortRow[];
  legacyHash: string;
  initialLegacyHash: string;
}

/** Reproduces stored legacy rows and hashes for the audited correction proof; it performs no writes. */
export async function computeLegacyV0Month(
  executor: SqlExecutor,
  orgId: string,
  month: string,
): Promise<LegacyV0Month> {
  const sources = await legacyReadSources(executor, orgId, month);
  const computed = await legacyComputeRows(executor, orgId, month, sources);
  const basis: FactsRow["basis"] = sources.revenueRecognitionEnabled ? "recognised" : "billed";
  const revenueBySubscription = new Map(
    sources.revenueRows.map((row) => [row.subscription_id, row.revenue]),
  );
  for (const row of computed.rows) {
    row.recognizedRevenue = revenueBySubscription.get(row.subscriptionId) ?? "0.0000";
  }
  const facts = legacyAggregateFacts(
    month,
    sources.subsidiaries.map((row) => row.id),
    computed.rows,
    sources.history,
    sources.ledgerRows,
    sources.billingRows,
    sources.deferredRows,
    basis,
  );
  const cohorts = legacyAggregateCohorts(
    month,
    computed.rows,
    sources.history,
    sources.cohortStartRows,
  );
  // The initial and repeated legacy hashes use different cohort-start sets.
  const cohortStarts = sources.cohortStartRows.map((row) => ({
    subsidiary_id: row.subsidiary_id,
    cohort_month: row.cohort_month,
    start_mrr: row.start_mrr,
    start_customers: row.start_customers,
  }));
  const payload = {
    orgId,
    month,
    baseCurrency: sources.baseCurrency,
    revenueRecognitionEnabled: sources.revenueRecognitionEnabled,
    subscriptions: computed.rows,
    cohortStarts,
    definitions: sources.definitions,
    rates: computed.rates,
    revenue: sources.revenueRows,
    deferred: sources.deferredRows,
    ledger: sources.ledgerRows,
    billings: sources.billingRows,
    subsidiaries: sources.subsidiaries,
  };
  const legacyHash = legacyInputsHash(payload);
  const initialLegacyHash = legacyInputsHash({
    ...payload,
    cohortStarts: cohortStarts.filter((row) => row.cohort_month.slice(0, 10) < month),
  });
  return { monthly: computed.rows, facts, cohorts, legacyHash, initialLegacyHash };
}
