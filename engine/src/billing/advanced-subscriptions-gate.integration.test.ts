import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { createPlanVersion } from "./advanced-subscriptions.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

// A disable racing a plan-version write must refuse the write: the gate is
// fenced on the writer's transaction, so the check and the inserts serialize
// against the switchboard change instead of observing a stale state.

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedPlan(org: ScratchOrg, creatorId: string): Promise<string> {
  const planId = randomUUID();
  await db.execute(sql`
    insert into subscription_plans
      (id, org_id, name, amount, currency_code, interval, interval_count,
       income_account_id, is_active, created_by)
    values (${planId}, ${org.orgId}, 'Gate Plan', '0', 'CAD', 'monthly', 1,
            ${org.accounts.revenue}, true, ${creatorId})`);
  return planId;
}

function versionInput(planId: string, revenueAccountId: string) {
  return {
    planId,
    effectiveFrom: "2026-05-01",
    components: [
      {
        componentKey: "platform",
        name: "Platform fee",
        quantity: "1",
        unitPrice: "100.00",
        incomeAccountId: revenueAccountId,
      },
    ],
  };
}

test("plan versions refuse while advanced subscriptions are off", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Gate controller", "admin");
    const planId = await seedPlan(org, actor);
    await assert.rejects(
      createPlanVersion(org.orgId, actor, versionInput(planId, org.accounts.revenue), null),
      /disabled/,
      "no version is published for a switched-off surface",
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("a disable racing a plan version refuses the write", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Gate controller", "admin");
    await db.execute(sql`
      update orgs
         set settings = settings || '{"features":{"subscriptionBilling":true,"advancedSubscriptions":true}}'::jsonb
       where id = ${org.orgId}`);
    const planId = await seedPlan(org, actor);
    // Stage the disable in an open transaction: the uncommitted UPDATE holds
    // the orgs row, so a fenced writer blocks on its recheck until the
    // disable commits. An unfenced read sails through on the old state and
    // publishes the version anyway.
    let release!: () => void;
    let staged = false;
    const disableTx = withOrgTransaction(org.orgId, async () => {
      await db.execute(sql`
        update orgs
           set settings = jsonb_set(settings, '{features,advancedSubscriptions}', 'false'::jsonb)
         where id = ${org.orgId}`);
      staged = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const writeSettled = createPlanVersion(
      org.orgId,
      actor,
      versionInput(planId, org.accounts.revenue),
      null,
    ).then(
      (id) => ({ ok: true as const, id }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    while (!staged) await new Promise((resolve) => setTimeout(resolve, 25));
    // Let the writer reach its gate: fenced it blocks on the staged row,
    // unfenced it runs to completion on the pre-disable state.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    release();
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("plan version write did not settle after the disable committed")), 30000);
    });
    const result = await Promise.race([writeSettled, timeout]);
    await disableTx;
    assert.equal(result.ok, false, "the racing disable refuses the version instead of publishing it while off");
    assert.match(String((result as { ok: false; error: unknown }).error), /disabled/);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
