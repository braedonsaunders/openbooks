import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { neg, toUnits } from "../../money/money.ts";
import { runScenario } from "../../golden/scenario.ts";
import { cancelRevenueRecognitionForInvoice } from "../../ledger/revenue-recognition-cancellation.ts";
import { db, withBypassContext } from "../../platform/db.ts";
import { runRevenueRecognition } from "../../revenue/recognition.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../../testing/fixtures.ts";
import { createSubscriptionInvoice } from "../subscription-billing.ts";
import { UsageBillingError } from "../usage/errors.ts";
import { recomputeSaasMetrics } from "./metrics-ledger.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const MONTH = "2026-07-01";

type Movement = "new" | "expansion" | "contraction" | "churn" | "reactivation" | "flat";

async function enableMetrics(orgId: string): Promise<void> {
  const result = await db.execute<{ id: string }>(sql`
    update orgs set settings = jsonb_set(
      settings,
      '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"subscriptionBilling":true,"saasMetrics":true,"revenueRecognition":true}'::jsonb
    ) where id = ${orgId} returning id
  `);
  assert.equal(result.rows.length, 1, "the feature setting must be applied to the scratch organization");
}

async function seedSubscription(args: {
  orgId: string;
  customerId: string;
  actorId: string;
  subscriptionId: string;
  planId: string;
  amount: string;
  status?: "active" | "paused" | "canceled";
  startOn: string;
  canceledOn?: string | null;
}): Promise<void> {
  const plan = await db.execute<{ id: string }>(sql`
    insert into subscription_plans
      (id, org_id, name, amount, currency_code, interval, interval_count, income_account_id, created_by)
    values (${args.planId}, ${args.orgId}, ${`Metrics plan ${args.planId.slice(0, 8)}`}, ${args.amount}, 'CAD', 'monthly', 1, null, ${args.actorId})
    returning id
  `);
  assert.equal(plan.rows.length, 1, "the subscription plan must be stored");
  const subscription = await db.execute<{ id: string }>(sql`
    insert into subscriptions
      (id, org_id, customer_id, plan_id, quantity, price_override, status, start_on, next_bill_on, canceled_on, auto_post, created_by)
    values (${args.subscriptionId}, ${args.orgId}, ${args.customerId}, ${args.planId}, '1', ${args.amount},
            ${args.status ?? "active"}, ${args.startOn}, '2026-08-15', ${args.canceledOn ?? null}, false, ${args.actorId})
    returning id
  `);
  assert.equal(subscription.rows.length, 1, "the subscription must be stored");
}

async function seedPriorMetric(args: {
  orgId: string;
  subsidiaryId: string;
  customerId: string;
  subscriptionId: string;
  month: string;
  mrrEnd: string;
  movement: Movement;
}): Promise<void> {
  const result = await db.execute<{ id: string }>(sql`
    insert into saas_metrics_monthly
      (org_id, subsidiary_id, customer_id, subscription_id, month, cohort_month,
       mrr_start, mrr_end, new_mrr, expansion_mrr, contraction_mrr, churned_mrr,
       reactivation_mrr, movement, recognized_revenue, deferred_delta, inputs_hash)
    values (${args.orgId}, ${args.subsidiaryId}, ${args.customerId}, ${args.subscriptionId},
            ${args.month}::date, ${args.month}::date, '0', ${args.mrrEnd},
            ${args.movement === "new" ? args.mrrEnd : "0"}, '0', '0', '0', '0',
            ${args.movement}, '0', '0', 'history-seed')
    returning id
  `);
  assert.equal(result.rows.length, 1, "the prior-month metric must be stored");
}

test("SaaS metrics movements reconcile by subsidiary and a bad movement identity is refused", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = randomUUID();
    const secondSubsidiaryId = randomUUID();
    const secondCustomerId = randomUUID();
    await withBypassContext(async () => {
      await enableMetrics(org.orgId);
      const subsidiary = await db.execute<{ id: string }>(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${secondSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Metrics Entity Two', 'CAD', 'CA')
        returning id
      `);
      assert.equal(subsidiary.rows.length, 1, "the second legal entity must be stored");
      const customer = await db.execute<{ id: string }>(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id)
        values (${secondCustomerId}, ${org.orgId}, 'company', 'Metrics Customer Two', ${secondSubsidiaryId})
        returning id
      `);
      assert.equal(customer.rows.length, 1, "the second billing account must be stored");
    });

    const ids = {
      new: randomUUID(),
      expansion: randomUUID(),
      contraction: randomUUID(),
      churn: randomUUID(),
      reactivation: randomUUID(),
    };
    const plans = Object.fromEntries(Object.keys(ids).map((kind) => [kind, randomUUID()])) as Record<keyof typeof ids, string>;
    await withBypassContext(async () => {
      await seedSubscription({ orgId: org.orgId, customerId: org.customerId, actorId, subscriptionId: ids.new, planId: plans.new, amount: "100", startOn: "2026-07-15" });
      await seedSubscription({ orgId: org.orgId, customerId: org.customerId, actorId, subscriptionId: ids.expansion, planId: plans.expansion, amount: "150", startOn: "2026-06-01" });
      await seedSubscription({ orgId: org.orgId, customerId: secondCustomerId, actorId, subscriptionId: ids.contraction, planId: plans.contraction, amount: "150", startOn: "2026-06-01" });
      await seedSubscription({ orgId: org.orgId, customerId: org.customerId, actorId, subscriptionId: ids.churn, planId: plans.churn, amount: "100", status: "canceled", startOn: "2026-06-01", canceledOn: "2026-07-10" });
      await seedSubscription({ orgId: org.orgId, customerId: secondCustomerId, actorId, subscriptionId: ids.reactivation, planId: plans.reactivation, amount: "75", startOn: "2026-05-01" });
      await seedPriorMetric({ orgId: org.orgId, subsidiaryId: org.subsidiaryId, customerId: org.customerId, subscriptionId: ids.expansion, month: "2026-06-01", mrrEnd: "100", movement: "new" });
      await seedPriorMetric({ orgId: org.orgId, subsidiaryId: secondSubsidiaryId, customerId: secondCustomerId, subscriptionId: ids.contraction, month: "2026-06-01", mrrEnd: "200", movement: "new" });
      await seedPriorMetric({ orgId: org.orgId, subsidiaryId: org.subsidiaryId, customerId: org.customerId, subscriptionId: ids.churn, month: "2026-06-01", mrrEnd: "100", movement: "new" });
      await seedPriorMetric({ orgId: org.orgId, subsidiaryId: secondSubsidiaryId, customerId: secondCustomerId, subscriptionId: ids.reactivation, month: "2026-05-01", mrrEnd: "50", movement: "new" });
      const reactivation = await db.execute<{ id: string }>(sql`
        insert into saas_metrics_monthly
          (org_id, subsidiary_id, customer_id, subscription_id, month, cohort_month,
           mrr_start, mrr_end, new_mrr, expansion_mrr, contraction_mrr, churned_mrr,
           reactivation_mrr, movement, recognized_revenue, deferred_delta, inputs_hash)
        values (${org.orgId}, ${secondSubsidiaryId}, ${secondCustomerId}, ${ids.reactivation},
                '2026-06-01', '2026-05-01', '50', '0', '0', '0', '0', '50', '0', 'churn', '0', '0', 'history-seed')
        returning id
      `);
      assert.equal(reactivation.rows.length, 1, "the churned month before reactivation must be stored");
    });

    const result = await recomputeSaasMetrics(org.orgId, MONTH);
    assert.equal(result.subscriptionRows, 5);
    assert.equal(result.subsidiaryRows, 2);
    const rows = (await db.execute<{
      subscription_id: string;
      movement: Movement;
      mrr_start: string;
      mrr_end: string;
      new_mrr: string;
      expansion_mrr: string;
      contraction_mrr: string;
      churned_mrr: string;
      reactivation_mrr: string;
    }>(sql`
      select subscription_id, movement, mrr_start::text, mrr_end::text, new_mrr::text,
             expansion_mrr::text, contraction_mrr::text, churned_mrr::text, reactivation_mrr::text
        from saas_metrics_monthly where org_id = ${org.orgId} and month = ${MONTH}::date
    `)).rows;
    const byId = new Map(rows.map((row) => [row.subscription_id, row]));
    assert.equal(byId.get(ids.new)?.movement, "new");
    assert.equal(byId.get(ids.expansion)?.movement, "expansion");
    assert.equal(byId.get(ids.expansion)?.expansion_mrr, "50.0000");
    assert.equal(byId.get(ids.contraction)?.movement, "contraction");
    assert.equal(byId.get(ids.contraction)?.contraction_mrr, "50.0000");
    assert.equal(byId.get(ids.churn)?.movement, "churn");
    assert.equal(byId.get(ids.churn)?.churned_mrr, "100.0000");
    assert.equal(byId.get(ids.reactivation)?.movement, "reactivation");
    assert.equal(byId.get(ids.reactivation)?.reactivation_mrr, "75.0000");
    for (const row of rows) {
      const delta = toUnits(row.mrr_end) - toUnits(row.mrr_start);
      const movements = toUnits(row.new_mrr)
        + toUnits(row.expansion_mrr)
        + toUnits(row.reactivation_mrr)
        - toUnits(row.contraction_mrr)
        - toUnits(row.churned_mrr);
      assert.equal(delta, movements, `movement identity for ${row.subscription_id}`);
    }
    const totals = await db.execute<{ mrr_end: string; recognized_revenue: string; deferred_delta: string }>(sql`
      select sum(mrr_end)::text as mrr_end, sum(recognized_revenue)::text as recognized_revenue,
             sum(deferred_delta)::text as deferred_delta
        from saas_metrics_facts_monthly where org_id = ${org.orgId} and month = ${MONTH}::date
    `);
    assert.equal(totals.rows[0]!.mrr_end, "475.0000", "subsidiary facts sum to the organization total");
    assert.equal(totals.rows[0]!.recognized_revenue, "0.0000");
    assert.equal(totals.rows[0]!.deferred_delta, "0.0000");

    await assert.rejects(
      withBypassContext(() => db.execute(sql`
        insert into saas_metrics_monthly
          (org_id, subsidiary_id, customer_id, subscription_id, month, cohort_month,
           mrr_start, mrr_end, new_mrr, expansion_mrr, contraction_mrr, churned_mrr,
           reactivation_mrr, movement, recognized_revenue, deferred_delta, inputs_hash)
        values (${org.orgId}, ${org.subsidiaryId}, ${org.customerId}, ${ids.new},
                '2026-08-01', '2026-07-01', '0', '100', '99', '0', '0', '0', '0', 'new', '0', '0', 'bad-identity')
      `)),
      (error: unknown) => {
        const wrapped = error as { constraint?: string; cause?: { constraint?: string } } | null;
        return wrapped?.constraint === "saas_metrics_monthly_movement_identity"
          || wrapped?.cause?.constraint === "saas_metrics_monthly_movement_identity";
      },
      "storage refuses a movement amount that does not reconcile to MRR",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("closed SaaS metrics months freeze after their first computation", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = randomUUID();
    const planId = randomUUID();
    const subscriptionId = randomUUID();
    await withBypassContext(async () => {
      await enableMetrics(org.orgId);
      await seedSubscription({ orgId: org.orgId, customerId: org.customerId, actorId, subscriptionId, planId, amount: "100", startOn: "2026-07-01" });
      const usePlanPrice = await db.execute<{ id: string }>(sql`
        update subscriptions set price_override = null where org_id = ${org.orgId} and id = ${subscriptionId}
        returning id
      `);
      assert.equal(usePlanPrice.rows.length, 1, "the subscription must use its plan price");
    });
    await recomputeSaasMetrics(org.orgId, MONTH);
    await withBypassContext(async () => {
      const periodLock = await db.execute<{ period_id: string }>(sql`
        insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state)
        values (${org.orgId}, ${org.periodId}, ${org.bookId}, null, 'ar', 'closed')
        returning period_id
      `);
      assert.equal(periodLock.rows.length, 1, "the test period must be closed");
      const changedPlan = await db.execute<{ id: string }>(sql`
        update subscription_plans set amount = '120' where org_id = ${org.orgId} and id = ${planId}
        returning id
      `);
      assert.equal(changedPlan.rows.length, 1, "the plan price input must change");
    });
    await assert.rejects(
      recomputeSaasMetrics(org.orgId, MONTH),
      (error: unknown) => error instanceof UsageBillingError
        && error.code === "saas_metrics_closed_month_changed"
        && error.status === 409
        && /reopen the period/i.test(error.remedy)
        && /accept the frozen month/i.test(error.remedy),
      "changed inputs in a closed month name both available remedies",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("voided subscription invoices preserve closed-month metrics and reverse in the void month", { skip: !DB }, async () => {
  const org = await createScratchOrg(), actorId = await createScratchUser(org.orgId, "Metrics void controller", "admin");
  try {
    const subscriptionId = randomUUID(), planId = randomUUID();
    await withBypassContext(async () => {
      await enableMetrics(org.orgId);
      await seedSubscription({ orgId: org.orgId, customerId: org.customerId, actorId, subscriptionId, planId, amount: "120", startOn: MONTH });
      const calendar = (await db.execute<{ id: string }>(sql`select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId} and org_id = ${org.orgId}`)).rows[0]!;
      const periods = await db.execute(sql`insert into accounting_periods (org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        select ${org.orgId}, extract(year from month_start)::int, extract(month from month_start)::int, to_char(month_start, 'YYYY-MM'), month_start,
          (month_start + interval '1 month - 1 day')::date, false, ${calendar.id} from generate_series('2026-08-01'::date, '2027-06-01'::date, interval '1 month') months(month_start) returning id`);
      assert.equal(periods.rows.length, 11);
    });
    const invoice = await createSubscriptionInvoice({ orgId: org.orgId, actorId, customerId: org.customerId, subsidiaryId: org.subsidiaryId,
      currency: "CAD", incomeAccountId: org.accounts.revenue, itemId: org.items.service, taxCodeId: null, description: "Subscription",
      quantity: "1", unitPrice: "120", memo: "Subscription invoice", invoiceDate: org.date, autoPost: true, custom: { subscriptionId } });
    assert.equal((await runRevenueRecognition(org.orgId, "2026-07-31", actorId)).posted, 1); await recomputeSaasMetrics(org.orgId, MONTH); await recomputeSaasMetrics(org.orgId, MONTH);
    const snapshot = async () => (await db.execute<{ value: string }>(sql`select jsonb_build_object('subscription', (select to_jsonb(m) from saas_metrics_monthly m where m.org_id = ${org.orgId} and m.subscription_id = ${subscriptionId} and m.month = ${MONTH}::date), 'facts',
      (select to_jsonb(f) from saas_metrics_facts_monthly f where f.org_id = ${org.orgId} and f.month = ${MONTH}::date))::text as value`)).rows[0]?.value;
    const julyBefore = await snapshot(); assert.ok(julyBefore);
    await withBypassContext(async () => {
      const closed = await db.execute(sql`insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state) values (${org.orgId}, ${org.periodId}, ${org.bookId}, null, 'ar', 'closed') returning period_id`); assert.equal(closed.rows.length, 1, "July AR must be closed before the void");
    });
    const voided = await cancelRevenueRecognitionForInvoice({ documentId: invoice.invoiceId, orgId: org.orgId, actorId, reason: "Subscription cancelled by customer", reversalDate: "2026-08-15", allowedSubsidiaryIds: null }); assert.equal(voided.status, "cancelled");
    assert.equal((await recomputeSaasMetrics(org.orgId, MONTH)).frozen, true); assert.equal(await snapshot(), julyBefore, "the closed July facts must remain byte-identical");
    await recomputeSaasMetrics(org.orgId, "2026-08-01");
    const rows = (await db.execute<{ revenue: string; deferredDelta: string; billings: string; deferredBalance: string }>(sql`
      select m.recognized_revenue::text as revenue, m.deferred_delta::text as "deferredDelta", f.billings::text as billings, f.deferred_balance::text as "deferredBalance"
        from saas_metrics_monthly m join saas_metrics_facts_monthly f on f.org_id = m.org_id and f.subsidiary_id = m.subsidiary_id and f.month = m.month
       where m.org_id = ${org.orgId} and m.subscription_id = ${subscriptionId} order by m.month`)).rows;
    assert.equal(rows.length, 2); assert.ok([rows[0]!.revenue, rows[0]!.billings, rows[0]!.deferredDelta].every((value) => value !== "0.0000"));
    assert.deepEqual([rows[1]!.revenue, rows[1]!.billings, rows[1]!.deferredDelta, rows[1]!.deferredBalance], [neg(rows[0]!.revenue), neg(rows[0]!.billings), neg(rows[0]!.deferredDelta), "0.0000"]); assert.equal((await runScenario(org.orgId, { at: "2026-08-15" })).checks.find((item) => item.name === "saas-metrics-tieout")?.ok, true);
  } finally { await dropScratchOrg(org.orgId); }
});

test("SaaS metrics refuse by name when their feature is off", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await assert.rejects(
      recomputeSaasMetrics(org.orgId, MONTH),
      (error: unknown) => error instanceof UsageBillingError
        && error.code === "feature_off"
        && /Company Settings → Features/.test(error.remedy),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
