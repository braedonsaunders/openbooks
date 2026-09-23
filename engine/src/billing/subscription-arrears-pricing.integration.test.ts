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
  publishPlanVersion,
} from "./advanced-subscriptions.ts";
import { prorateDays } from "../money/money.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

const PRICE_A = "310.0000";
const PRICE_B = "620.0000";

/** Arrears monthly contract serving January, billed Feb 1. */
async function seedArrearsJanuary(org: ScratchOrg, actor: string): Promise<string> {
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
    values (${planId}, ${org.orgId}, 'Arrears plan', '0', 'CAD', 'monthly', 1,
            ${org.accounts.revenue}, true, ${actor})
  `);
  const versionId = await createPlanVersion(org.orgId, actor, {
    planId,
    effectiveFrom: "2026-01-01",
    billingTiming: "arrears",
    components: [
      {
        componentKey: "fee",
        name: "Fee",
        quantity: "1",
        unitPrice: PRICE_A,
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
    termEndsOn: "2026-12-31",
    renewalPolicy: "none",
  });
  return subscriptionId;
}

async function withOrg(run: (org: ScratchOrg, actor: string) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Arrears pricing controller", "admin");
    await run(org, actor);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

test("a Jan 1 - Feb 1 arrears bill charges price A, not the Feb 1 price B", DB, async () => {
  await withOrg(async (org, actor) => {
    const subscriptionId = await seedArrearsJanuary(org, actor);
    await applyAmendment(org.orgId, actor, {
      subscriptionId,
      type: "change_component",
      componentKey: "fee",
      effectiveOn: "2026-02-01",
      unitPrice: PRICE_B,
      idempotencyKey: randomUUID(),
    });
    const snapshot = (await advancedBillingSnapshot(org.orgId, subscriptionId, "2026-02-01"))!;
    assert.deepEqual(
      { startsOn: snapshot.periodStartsOn, endsOn: snapshot.periodEndsOn },
      { startsOn: "2026-01-01", endsOn: "2026-02-01" },
    );
    assert.equal(snapshot.lines.length, 1);
    assert.equal(snapshot.lines[0]!.unitPrice, PRICE_A);
    assert.equal(snapshot.lines[0]!.quantity, "1.0000");
    assert.equal(snapshot.total, PRICE_A);
  });
});

test("a mid-month arrears price change splits and prorates by effective window", DB, async () => {
  await withOrg(async (org, actor) => {
    const subscriptionId = await seedArrearsJanuary(org, actor);
    await applyAmendment(org.orgId, actor, {
      subscriptionId,
      type: "change_component",
      componentKey: "fee",
      effectiveOn: "2026-01-16",
      unitPrice: PRICE_B,
      idempotencyKey: randomUUID(),
    });
    const snapshot = (await advancedBillingSnapshot(org.orgId, subscriptionId, "2026-02-01"))!;
    assert.equal(snapshot.lines.length, 2);
    assert.equal(snapshot.lines[0]!.unitPrice, prorateDays(PRICE_A, 15, 31));
    assert.equal(snapshot.lines[1]!.unitPrice, prorateDays(PRICE_B, 16, 31));
    assert.equal(snapshot.total, "470.0000");
  });
});

test("an unchanged arrears price bills one line as before", DB, async () => {
  await withOrg(async (org, actor) => {
    const subscriptionId = await seedArrearsJanuary(org, actor);
    const snapshot = (await advancedBillingSnapshot(org.orgId, subscriptionId, "2026-02-01"))!;
    assert.equal(snapshot.lines.length, 1);
    assert.equal(snapshot.lines[0]!.description, "Fee");
    assert.equal(snapshot.lines[0]!.quantity, "1.0000");
    assert.equal(snapshot.lines[0]!.unitPrice, PRICE_A);
  });
});
