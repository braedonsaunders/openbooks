import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { runScenario } from "../golden/scenario.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function check(cp: Awaited<ReturnType<typeof runScenario>>, name: string) {
  const result = cp.checks.find((item) => item.name === name);
  assert.ok(result, `checkpoint must carry the ${name} check`);
  return result;
}

test("saas-metrics-tieout names a fact mismatch against the independent ledger", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const month = "2026-07-01";
  const subscriptionId = randomUUID();
  const planId = randomUUID();
  try {
    await withBypassContext(async () => {
      const plan = await db.execute<{ id: string }>(sql`
        insert into subscription_plans
          (id, org_id, name, amount, currency_code, interval, interval_count)
        values (${planId}, ${org.orgId}, 'Metrics tie-out plan', '100.0000', 'CAD', 'monthly', 1)
        returning id
      `);
      assert.equal(plan.rows.length, 1, "the source plan must be stored");
      const subscription = await db.execute<{ id: string }>(sql`
        insert into subscriptions
          (id, org_id, customer_id, plan_id, quantity, price_override, status,
           start_on, next_bill_on, auto_post)
        values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${planId}, '1', '100.0000',
                'active', ${month}::date, '2026-08-15', false)
        returning id
      `);
      assert.equal(subscription.rows.length, 1, "the source subscription must be stored");
      const monthly = await db.execute<{ id: string }>(sql`
        insert into saas_metrics_monthly
          (org_id, subsidiary_id, customer_id, subscription_id, month, cohort_month,
           mrr_start, mrr_end, new_mrr, expansion_mrr, contraction_mrr, churned_mrr,
           reactivation_mrr, movement, recognized_revenue, deferred_delta, inputs_hash)
        values (${org.orgId}, ${org.subsidiaryId}, ${org.customerId}, ${subscriptionId},
                ${month}::date, ${month}::date, 0, 100, 100, 0, 0, 0, 0,
                'new', 0, 0, 'saas-metrics-red-proof')
        returning id
      `);
      assert.equal(monthly.rows.length, 1, "one subscription fact must be stored");
      const inserted = await db.execute<{ id: string }>(sql`
        insert into saas_metrics_facts_monthly
          (org_id, subsidiary_id, month, mrr_start, mrr_end, new_mrr, expansion_mrr,
           contraction_mrr, churned_mrr, reactivation_mrr, recognized_revenue, deferred_delta,
           mrr_at_risk, customers_start, customers_end, customers_new, customers_churned,
           customers_reactivated, gl_revenue, gl_cogs, bookings, billings, deferred_balance,
           basis, inputs_hash)
        values (${org.orgId}, ${org.subsidiaryId}, ${month}::date,
                0, 100, 100, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0,
                0, 0, 0, 0, 0, 'billed', 'saas-metrics-red-proof')
        returning id
      `);
      assert.equal(inserted.rows.length, 1, "baseline SaaS facts must be stored");
    });

    const baseline = await runScenario(org.orgId, { at: org.date });
    assert.equal(check(baseline, "saas-metrics-tieout").ok, true, "the consistent fact row is golden");

    await withBypassContext(async () => {
      const updated = await db.execute<{ id: string }>(sql`
        update saas_metrics_facts_monthly set recognized_revenue = '35.0000'
         where org_id = ${org.orgId} and subsidiary_id = ${org.subsidiaryId} and month = ${month}::date
        returning id
      `);
      assert.equal(updated.rows.length, 1, "the intended subsidiary-month fact must be updated");
    });

    const divergent = await runScenario(org.orgId, { at: org.date });
    const tie = check(divergent, "saas-metrics-tieout");
    assert.equal(tie.ok, false, `the tie-out must fail on the misstated recognized amount: ${tie.detail}`);
    assert.match(
      tie.detail,
      new RegExp(`${month.slice(0, 7)} subsidiary ${org.subsidiaryId}: recognized_revenue residual 35\\.0000`),
      "detail must name the month, subsidiary, and exact residual",
    );
    assert.equal(divergent.pass, false, "a diverged fact row cannot be golden");
    for (const other of divergent.checks.filter((item) => item.name !== "saas-metrics-tieout")) {
      assert.equal(other.ok, true, `${other.name} must stay green here — only the metrics tie-out fires`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
