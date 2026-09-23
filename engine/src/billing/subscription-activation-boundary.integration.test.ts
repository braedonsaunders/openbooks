import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  activateLifecycle,
  createPlanVersion,
  publishPlanVersion,
} from "./advanced-subscriptions.ts";
import { runDueSubscriptions } from "./subscription-billing.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

async function seedMonthlyPlan(org: ScratchOrg, actor: string): Promise<string> {
  await db.execute(sql`
    update orgs
       set settings = settings || '{"features":{"subscriptionBilling":true,"advancedSubscriptions":true}}'::jsonb
     where id = ${org.orgId}
  `);
  const planId = randomUUID();
  await db.execute(sql`
    insert into subscription_plans
      (id, org_id, name, amount, currency_code, interval, interval_count,
       income_account_id, is_active, created_by)
    values (${planId}, ${org.orgId}, 'Monthly plan', '100.0000', 'CAD', 'monthly', 1,
            ${org.accounts.revenue}, true, ${actor})
  `);
  return planId;
}

async function seedQuarterlyVersion(org: ScratchOrg, actor: string, planId: string): Promise<string> {
  const versionId = await createPlanVersion(org.orgId, actor, {
    planId,
    effectiveFrom: "2026-01-01",
    interval: "quarterly",
    billingTiming: "advance",
    components: [
      {
        componentKey: "fee",
        name: "Fee",
        quantity: "1",
        unitPrice: "300.0000",
        incomeAccountId: org.accounts.revenue,
      },
    ],
  });
  await publishPlanVersion(org.orgId, actor, versionId);
  return versionId;
}

async function seedPlainSubscription(org: ScratchOrg, actor: string, planId: string): Promise<string> {
  const subscriptionId = randomUUID();
  await db.execute(sql`
    insert into subscriptions
      (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on,
       auto_post, created_by)
    values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${planId}, '1', 'active',
            '2026-01-01', '2026-01-01', false, ${actor})
  `);
  return subscriptionId;
}

async function cursors(orgId: string, subscriptionId: string): Promise<{ nextBillOn: string; currentPeriodStart: string }> {
  const row = (await db.execute<{ nextBillOn: string; currentPeriodStart: string }>(
    sql`select next_bill_on as "nextBillOn", current_period_start as "currentPeriodStart"
          from subscriptions where id = ${subscriptionId} and org_id = ${orgId}`,
  )).rows[0]!;
  return { nextBillOn: row.nextBillOn, currentPeriodStart: row.currentPeriodStart };
}

async function guardedPeriods(orgId: string, subscriptionId: string): Promise<Array<{ startsOn: string; endsOn: string }>> {
  return (await db.execute<{ startsOn: string; endsOn: string }>(sql`
    select period_starts_on as "startsOn", period_ends_on as "endsOn" from subscription_period_invoices
     where org_id = ${orgId} and subscription_id = ${subscriptionId} order by period_starts_on
  `)).rows;
}

async function withOrg(run: (org: ScratchOrg, actor: string) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Activation boundary controller", "admin");
    await run(org, actor);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

test("activating over billed service refuses naming the unbilled boundary", DB, async () => {
  await withOrg(async (org, actor) => {
    const planId = await seedMonthlyPlan(org, actor);
    const versionId = await seedQuarterlyVersion(org, actor, planId);
    const subscriptionId = await seedPlainSubscription(org, actor, planId);
    const billed = await runDueSubscriptions("2026-01-01");
    assert.equal(billed.billed, 1);
    assert.deepEqual(await cursors(org.orgId, subscriptionId), { nextBillOn: "2026-02-01", currentPeriodStart: "2026-01-01" });
    await assert.rejects(
      activateLifecycle(org.orgId, actor, {
        subscriptionId,
        planVersionId: versionId,
        termStartsOn: "2026-01-01",
        termEndsOn: "2027-01-01",
        renewalPolicy: "none",
      }),
      /already-billed service through 2026-02-01.*billFromUnbilledBoundary/,
    );
    assert.deepEqual(await cursors(org.orgId, subscriptionId), { nextBillOn: "2026-02-01", currentPeriodStart: "2026-01-01" });
  });
});

test("the controlled transition bills from the boundary and never invoices January twice", DB, async () => {
  await withOrg(async (org, actor) => {
    const planId = await seedMonthlyPlan(org, actor);
    const versionId = await seedQuarterlyVersion(org, actor, planId);
    const subscriptionId = await seedPlainSubscription(org, actor, planId);
    await runDueSubscriptions("2026-01-01");
    await activateLifecycle(org.orgId, actor, {
      subscriptionId,
      planVersionId: versionId,
      termStartsOn: "2026-01-01",
      termEndsOn: "2027-01-01",
      renewalPolicy: "none",
      billFromUnbilledBoundary: true,
    });
    assert.deepEqual(await cursors(org.orgId, subscriptionId), { nextBillOn: "2026-02-01", currentPeriodStart: "2026-02-01" });
    const billed = await runDueSubscriptions("2026-02-01");
    assert.equal(billed.billed, 1);
    assert.deepEqual(await guardedPeriods(org.orgId, subscriptionId), [
      { startsOn: "2026-01-01", endsOn: "2026-02-01" },
      { startsOn: "2026-02-01", endsOn: "2026-05-01" },
    ]);
  });
});

test("a never-billed subscription activates at its term dates as before", DB, async () => {
  await withOrg(async (org, actor) => {
    const planId = await seedMonthlyPlan(org, actor);
    const versionId = await seedQuarterlyVersion(org, actor, planId);
    const subscriptionId = await seedPlainSubscription(org, actor, planId);
    await activateLifecycle(org.orgId, actor, {
      subscriptionId,
      planVersionId: versionId,
      termStartsOn: "2026-01-01",
      termEndsOn: "2027-01-01",
      renewalPolicy: "none",
    });
    assert.deepEqual(await cursors(org.orgId, subscriptionId), { nextBillOn: "2026-01-01", currentPeriodStart: "2026-01-01" });
  });
});
