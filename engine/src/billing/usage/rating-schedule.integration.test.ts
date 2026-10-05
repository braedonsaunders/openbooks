import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../../testing/fixtures.ts";
import { createUsageMeter, ingestUsageRecords } from "./records.ts";
import { createSubscriptionUsageLink, createUsageRatingPlan, createUsageRatingPlanVersion, publishUsagePlanVersion, replaceUsageRatingBands } from "./rating-plans.ts";
import { runDueUsageRating } from "./rating-schedule.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

async function fixture(run: (org: ScratchOrg, actor: string) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await withOrgContext(org.orgId, () => createScratchUser(org.orgId, "Usage rating scheduler", "admin"));
    await withOrgContext(org.orgId, async () => {
      const enabled = await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}',
          coalesce(settings->'features', '{}'::jsonb)
            || '{"subscriptionBilling":true,"usageBilling":true}'::jsonb, true)
         where id = ${org.orgId}`);
      assert.equal(enabled.rowCount, 1);
    });
    await withOrgContext(org.orgId, () => run(org, actor));
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

/** A link whose July 2026 billing period already closed (the subscription
 * advanced to its August period), with three rated units recorded in July. */
async function closedJulyLink(org: ScratchOrg, actor: string) {
  const itemId = randomUUID();
  await withOrgContext(org.orgId, async () => {
    const item = await db.execute(sql`insert into items (id, org_id, kind, name, income_account_id, is_active, custom)
      values (${itemId}, ${org.orgId}, 'service', ${`Schedule item ${itemId.slice(0, 8)}`}, ${org.accounts.revenue}, true, '{}'::jsonb) returning id`);
    assert.equal(item.rows.length, 1);
  });
  const usageMeter = await createUsageMeter(org.orgId, actor, {
    key: `sched-requests-${randomUUID()}`, name: "API requests", unit: "request", aggregation: "sum", itemId,
  });
  const subscriptionId = randomUUID();
  const planId = randomUUID();
  await withOrgContext(org.orgId, async () => {
    await db.execute(sql`insert into subscription_plans (id, org_id, name, amount, currency_code, "interval", interval_count)
      values (${planId}, ${org.orgId}, ${`Schedule plan ${planId.slice(0, 8)}`}, 0, 'CAD', 'monthly', 1)`);
    const row = await db.execute(sql`insert into subscriptions
      (id, org_id, customer_id, plan_id, quantity, status, start_on, current_period_start, next_bill_on)
      values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${planId}, 1, 'active', '2026-07-01', '2026-08-01', '2026-09-01') returning id`);
    assert.equal(row.rows.length, 1);
  });
  const plan = await createUsageRatingPlan(org.orgId, actor, { name: `Schedule rating ${randomUUID()}`, currency: "CAD" });
  const version = await createUsageRatingPlanVersion(org.orgId, actor, { planId: plan.id, effectiveFrom: "2026-07-01" });
  await replaceUsageRatingBands(org.orgId, actor, version.id, [
    { meterId: usageMeter.id, kind: "graduated", seq: 1, upToQty: "2", unitPrice: "1.25" },
    { meterId: usageMeter.id, kind: "graduated", seq: 2, upToQty: null, unitPrice: "2.5" },
  ]);
  await publishUsagePlanVersion(org.orgId, actor, version.id);
  const link = await createSubscriptionUsageLink(org.orgId, actor, {
    subscriptionId, customerId: org.customerId, planVersionId: version.id, meterIds: [usageMeter.id],
    effectiveFrom: "2026-07-01", commitAmount: null, commitPeriod: null, allowOverage: true,
  });
  await ingestUsageRecords(org.orgId, actor, [{
    meterKey: usageMeter.key, customerId: org.customerId, subscriptionId, occurredOn: "2026-07-14",
    quantity: "3", source: "api", idempotencyKey: randomUUID(),
  }]);
  return { link, subscriptionId };
}

async function ratingRuns(orgId: string, linkId: string) {
  return (await db.execute<{ id: string; invoiceId: string | null; periodStart: string; periodEnd: string }>(sql`
    select id, invoice_id as "invoiceId", period_start::text as "periodStart", period_end::text as "periodEnd"
      from usage_rating_runs where org_id = ${orgId} and link_id = ${linkId} and status = 'active'`)).rows;
}

async function watermark(orgId: string, linkId: string) {
  return (await db.execute<{ end: string | null }>(sql`
    select last_rated_period_end::text as "end" from usage_rating_settings
     where org_id = ${orgId} and link_id = ${linkId}`)).rows[0]?.end ?? null;
}

test("scheduled rating auto-commits the closed period once the grace period passes", DB, async () => {
  await fixture(async (org, actor) => {
    const { link } = await closedJulyLink(org, actor);
    await withOrgContext(org.orgId, async () => {
      const settings = await db.execute(sql`insert into usage_rating_settings (id, org_id, link_id, cadence, grace_days, mode, created_by)
        values (${randomUUID()}, ${org.orgId}, ${link.id}, 'billing_period', 2, 'auto_commit', ${actor}) returning id`);
      assert.equal(settings.rows.length, 1);
    });
    // Two days after the July close the grace period still holds: nothing rates.
    const waiting = await runDueUsageRating("2026-08-02");
    assert.equal(waiting.rated, 0);
    assert.equal(waiting.failed, 0);
    assert.deepEqual(await ratingRuns(org.orgId, link.id), []);

    const due = await runDueUsageRating("2026-08-03");
    assert.equal(due.rated, 1);
    assert.equal(due.invoiced, 1);
    assert.equal(due.failed, 0);
    const runs = await ratingRuns(org.orgId, link.id);
    assert.equal(runs.length, 1);
    assert.deepEqual([runs[0]!.periodStart, runs[0]!.periodEnd], ["2026-07-01", "2026-07-31"]);
    assert.ok(runs[0]!.invoiceId);
    assert.equal(await watermark(org.orgId, link.id), "2026-07-31");

    // A second pass over the same closed window rates nothing: one run per period.
    const replay = await runDueUsageRating("2026-08-03");
    assert.equal(replay.rated, 0);
    assert.equal((await ratingRuns(org.orgId, link.id)).length, 1);
  });
});

test("scheduled rating drafts by default and never stores a draft run", DB, async () => {
  await fixture(async (org, actor) => {
    const { link } = await closedJulyLink(org, actor);
    const due = await runDueUsageRating("2026-08-05");
    assert.equal(due.rated, 1);
    assert.equal(due.drafted, 1);
    assert.equal(due.invoiced, 0);
    assert.deepEqual(await ratingRuns(org.orgId, link.id), []);
    assert.equal(await watermark(org.orgId, link.id), "2026-07-31");
    void actor;
  });
});

test("a paused schedule never rates its closed periods", DB, async () => {
  await fixture(async (org, actor) => {
    const { link } = await closedJulyLink(org, actor);
    await withOrgContext(org.orgId, async () => {
      const settings = await db.execute(sql`insert into usage_rating_settings (id, org_id, link_id, cadence, grace_days, mode, created_by)
        values (${randomUUID()}, ${org.orgId}, ${link.id}, 'paused', 2, 'auto_commit', ${actor}) returning id`);
      assert.equal(settings.rows.length, 1);
    });
    const due = await runDueUsageRating("2026-08-10");
    assert.equal(due.rated, 0);
    assert.deepEqual(await ratingRuns(org.orgId, link.id), []);
    assert.equal(await watermark(org.orgId, link.id), null);
  });
});
