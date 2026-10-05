import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILT_IN_REPORT_DEFINITION_MAP } from "@openbooks/reports";
import { evaluateFormulaMeasures } from "@openbooks/reports";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../../testing/fixtures.ts";
import { readRetentionStrip, recomputeSaasMetrics } from "./metrics-ledger.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };
const MONTH = "2026-07-01";

function formulaValues(slug: string, facts: Record<string, string>): Map<string, string | null> {
  const definition = BUILT_IN_REPORT_DEFINITION_MAP[slug];
  assert.ok(definition, `built-in report ${slug} must exist`);
  const measures = definition.query.measures ?? [];
  const aggregates = measures.map((measure) => {
    if (measure.fn === "formula") return null;
    const column = measure.column ?? measure.key ?? "";
    return facts[column] ?? facts[measure.key ?? ""] ?? null;
  });
  const evaluated = evaluateFormulaMeasures(measures, aggregates);
  const byKey = new Map<string, string | null>();
  measures.forEach((measure, index) => {
    if (measure.key) byKey.set(measure.key, evaluated[index]!.value);
  });
  return byKey;
}

test("retention metrics on a seeded cohort equal hand-computed values", DB, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = randomUUID();
    const customerB = randomUUID();
    const customerC = randomUUID();
    const subA = randomUUID();
    const subB = randomUUID();
    const subC = randomUUID();
    await withOrgTransaction(org.orgId, async () => {
      const features = await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features','{}'::jsonb) || '{"subscriptionBilling":true,"saasMetrics":true,"revenueRecognition":true}'::jsonb, true) where id = ${org.orgId} returning id`);
      assert.equal(features.rows.length, 1);
      for (const [id, name] of [[customerB, "Retention B"], [customerC, "Retention C"]] as Array<[string, string]>) {
        const party = await db.execute(sql`insert into parties (id, org_id, kind, display_name) values (${id}, ${org.orgId}, 'customer', ${name}) returning id`);
        assert.equal(party.rows.length, 1);
      }
      const plans: Array<[string, string]> = [[randomUUID(), "100"], [randomUUID(), "150"], [randomUUID(), "200"]];
      const planIds = new Map<string, string>();
      for (const [planId, amount] of plans) {
        planIds.set(amount, planId);
        const plan = await db.execute(sql`insert into subscription_plans (id, org_id, name, amount, currency_code, "interval", interval_count)
          values (${planId}, ${org.orgId}, ${`Retention plan ${amount}`}, ${amount}, 'CAD', 'monthly', 1) returning id`);
        assert.equal(plan.rows.length, 1);
      }
      const subs: Array<[string, string, string, string, string, string | null]> = [
        [subA, org.customerId, planIds.get("100")!, "active", "2026-06-01", null],
        [subB, customerB, planIds.get("150")!, "active", "2026-06-01", null],
        [subC, customerC, planIds.get("200")!, "canceled", "2026-06-01", "2026-07-10"],
      ];
      for (const [id, customer, plan, status, startOn, canceledOn] of subs) {
        const amount = plan === planIds.get("100")! ? "100" : plan === planIds.get("150")! ? "150" : "200";
        const row = await db.execute(sql`insert into subscriptions
          (id, org_id, customer_id, plan_id, quantity, price_override, status, start_on, next_bill_on, canceled_on, created_by)
          values (${id}, ${org.orgId}, ${customer}, ${plan}, '1', ${amount}, ${status}, ${startOn}, '2026-08-15', ${canceledOn}, ${actorId}) returning id`);
        assert.equal(row.rows.length, 1);
      }
      const priors: Array<[string, string, string, string]> = [
        [subA, org.customerId, "100", "new"],
        [subB, customerB, "100", "new"],
        [subC, customerC, "200", "new"],
      ];
      for (const [sub, customer, mrrEnd, movement] of priors) {
        const row = await db.execute(sql`insert into saas_metrics_monthly
          (org_id, subsidiary_id, customer_id, subscription_id, month, cohort_month,
           mrr_start, mrr_end, new_mrr, expansion_mrr, contraction_mrr, churned_mrr,
           reactivation_mrr, movement, recognized_revenue, deferred_delta, inputs_hash,
           reporting_currency, denomination_version, normalization_evidence)
          values (${org.orgId}, ${org.subsidiaryId}, ${customer}, ${sub},
                  '2026-06-01', '2026-06-01', '0', ${mrrEnd},
                  ${mrrEnd}, '0', '0', '0', '0', ${movement}, '0', '0', 'history-seed',
                  'CAD', 'v1', '{"inputs_hash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}') returning id`);
        assert.equal(row.rows.length, 1);
      }
    });

    await recomputeSaasMetrics(org.orgId, MONTH);
    const facts = (await db.execute<Record<string, string>>(sql`
      select sum(mrr_start)::text as mrr_start, sum(mrr_end)::text as mrr_end,
             sum(expansion_mrr)::text as expansion_mrr, sum(contraction_mrr)::text as contraction_mrr,
             sum(churned_mrr)::text as churned_mrr,
             sum(customers_start)::int::text as customers_start,
             sum(customers_churned)::int::text as customers_churned
        from saas_metrics_facts_monthly where org_id = ${org.orgId} and month = ${MONTH}::date`)).rows[0]!;
    // The seeded cohort opens July with 100 + 100 + 200 of MRR across three
    // customers; July brings 50 of expansion and 200 of churn.
    assert.equal(facts.mrr_start, "400.0000");
    assert.equal(facts.expansion_mrr, "50.0000");
    assert.equal(facts.contraction_mrr, "0.0000");
    assert.equal(facts.churned_mrr, "200.0000");
    assert.equal(facts.customers_start, "3");
    assert.equal(facts.customers_churned, "1");

    // The report engine's own formulas over those stored facts must equal the
    // hand computation, rendered as percents: NRR (400 + 50 - 200) / 400,
    // GRR (400 - 200) / 400, revenue churn 200 / 400, logo churn 1 / 3.
    const retention = formulaValues("nrr-grr", facts as Record<string, string>);
    assert.equal(retention.get("nrr"), "62.50");
    assert.equal(retention.get("grr"), "50.00");
    const churn = formulaValues("revenue-churn", facts as Record<string, string>);
    assert.equal(churn.get("revenue_churn"), "50.00");
    assert.equal(churn.get("logo_churn"), "33.33");

    // The dashboard strip reads the same stored facts through the same
    // formula trees: NRR/GRR match, ARR is twelve times closing MRR
    // (250 x 12 = 3000), ARPA is closing MRR per closing customer
    // (250 / 2 = 125), quick ratio is growth over loss (50 / 200).
    const strip = await readRetentionStrip(org.orgId);
    assert.equal(strip.month, MONTH);
    assert.equal(strip.baseCurrency, "CAD");
    assert.equal(strip.rows.length, 1);
    const row = strip.rows[0]!;
    assert.equal(row.currency, "CAD");
    assert.equal(row.values.nrr, "62.50");
    assert.equal(row.values.grr, "50.00");
    assert.equal(row.values.revenue_churn, "50.00");
    assert.equal(row.values.logo_churn, "33.33");
    assert.equal(row.values.arr, "3000.0000");
    assert.equal(row.values.arpa, "125.0000");
    assert.equal(row.values.quick_ratio, "0.2500");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
