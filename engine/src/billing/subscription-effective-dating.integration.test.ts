import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  activateLifecycle,
  advancedBillingSnapshot,
  applyAmendment,
  createPlanVersion,
  prepareAdvancedSubscriptionBilling,
  publishPlanVersion,
} from "./advanced-subscriptions.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

async function seedAdvanceMonthly(
  org: ScratchOrg,
  actor: string,
  termEndsOn: string,
  renewalPolicy: "auto" | "manual" | "none" = "manual",
): Promise<string> {
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
    values (${planId}, ${org.orgId}, 'Advance plan', '0', 'CAD', 'monthly', 1,
            ${org.accounts.revenue}, true, ${actor})
  `);
  const versionId = await createPlanVersion(org.orgId, actor, {
    planId,
    effectiveFrom: "2026-01-01",
    billingTiming: "advance",
    components: [
      {
        componentKey: "fee",
        name: "Fee",
        quantity: "1",
        unitPrice: "100.0000",
        incomeAccountId: org.accounts.revenue,
      },
    ],
  });
  await publishPlanVersion(org.orgId, actor, versionId);
  const subscriptionId = randomUUID();
  await db.execute(sql`
    insert into subscriptions
      (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on,
       auto_post, created_by)
    values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${planId}, '1', 'active',
            '2026-01-01', '2026-01-01', false, ${actor})
  `);
  await activateLifecycle(org.orgId, actor, {
    subscriptionId,
    planVersionId: versionId,
    termStartsOn: "2026-01-01",
    termEndsOn,
    renewalPolicy,
  });
  return subscriptionId;
}

async function withOrg(run: (org: ScratchOrg, actor: string) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Effective dating controller", "admin");
    await run(org, actor);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

test("a July 1 timing change leaves June billing on the old timing", DB, async () => {
  await withOrg(async (org, actor) => {
    const subscriptionId = await seedAdvanceMonthly(org, actor, "2027-01-01");
    await applyAmendment(org.orgId, actor, {
      subscriptionId,
      type: "change_timing",
      effectiveOn: "2026-07-01",
      billingTiming: "arrears",
      idempotencyKey: randomUUID(),
    });
    const june = (await advancedBillingSnapshot(org.orgId, subscriptionId, "2026-06-01"))!;
    assert.equal(june.billingTiming, "advance");
    assert.deepEqual(
      { startsOn: june.periodStartsOn, endsOn: june.periodEndsOn },
      { startsOn: "2026-06-01", endsOn: "2026-07-01" },
    );
    const july = (await advancedBillingSnapshot(org.orgId, subscriptionId, "2026-07-01", "2026-06-01"))!;
    assert.equal(july.billingTiming, "arrears");
    assert.deepEqual(
      { startsOn: july.periodStartsOn, endsOn: july.periodEndsOn },
      { startsOn: "2026-06-01", endsOn: "2026-07-01" },
    );
  });
});

test("a future term reduction does not stop billing before its date", DB, async () => {
  await withOrg(async (org, actor) => {
    // Agreed termination June 15, recorded as an amendment effective July 1:
    // the June 20 tick must still bill under the term in force that day.
    const subscriptionId = await seedAdvanceMonthly(org, actor, "2027-01-01");
    await applyAmendment(org.orgId, actor, {
      subscriptionId,
      type: "change_term",
      effectiveOn: "2026-07-01",
      termEndsOn: "2026-06-15",
      idempotencyKey: randomUUID(),
    });
    assert.equal(await prepareAdvancedSubscriptionBilling(org.orgId, subscriptionId, "2026-06-20"), true);
    assert.equal(await prepareAdvancedSubscriptionBilling(org.orgId, subscriptionId, "2026-07-15"), false);
  });
});

test("a post-term timing change does not rewrite the boundary bill", DB, async () => {
  await withOrg(async (org, actor) => {
    // Advance billing bills exactly ON the term end; arrears would bill past
    // it. A timing change scheduled after the term must not move that line.
    const subscriptionId = await seedAdvanceMonthly(org, actor, "2026-07-01");
    await applyAmendment(org.orgId, actor, {
      subscriptionId,
      type: "change_timing",
      effectiveOn: "2026-08-01",
      billingTiming: "arrears",
      idempotencyKey: randomUUID(),
    });
    assert.equal(await prepareAdvancedSubscriptionBilling(org.orgId, subscriptionId, "2026-07-01"), false);
  });
});
