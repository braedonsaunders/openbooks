import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { ensureScopedContract } from "./contract-scope.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * A subscription-scoped contract carries the plan's persisted currency: the
 * plan table stores it as currency_code, and the scoped-contract subject
 * must read exactly that column — selecting a bare currency fails the whole
 * activation, and no fallback currency may be substituted.
 */
test("subscription-scoped contract reads the plan currency", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Scoped contract prover", "admin");
    async function subscriptionOnPlan(planName: string, currencyCode: string): Promise<string> {
      const planId = randomUUID();
      await db.execute(sql`
        insert into subscription_plans (id, org_id, name, amount, currency_code, interval, interval_count, is_active)
        values (${planId}, ${org.orgId}, ${planName}, '100.0000', ${currencyCode}, 'monthly', 1, true)
      `);
      const subscriptionId = randomUUID();
      await db.execute(sql`
        insert into subscriptions (id, org_id, customer_id, plan_id, start_on, next_bill_on)
        values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${planId}, '2026-10-01', '2026-11-01')
      `);
      return subscriptionId;
    }
    // Non-USD control: the persisted plan currency flows through untouched,
    // proving no USD (or other) fallback is substituted.
    const eurSubscription = await subscriptionOnPlan("Pro plan EUR", "EUR");
    const first = await ensureScopedContract(
      db,
      org.orgId,
      { kind: "subscription", id: eurSubscription, number: "Pro plan EUR" },
      org.customerId,
      "EUR",
      actor,
    );
    assert.equal(first.created, true);
    const contract = (await db.execute<{ scope: string; currency: string; subscription_id: string }>(sql`
      select scope, currency, subscription_id from revenue_contracts
       where id = ${first.id} and org_id = ${org.orgId}`)).rows[0];
    assert.equal(contract?.scope, "subscription");
    assert.equal(contract?.currency, "EUR");
    assert.equal(contract?.subscription_id, eurSubscription);
    const second = await ensureScopedContract(
      db,
      org.orgId,
      { kind: "subscription", id: eurSubscription, number: "Pro plan EUR" },
      org.customerId,
      "EUR",
      actor,
    );
    assert.equal(second.created, false);
    assert.equal(second.id, first.id);
    // A document in another currency than the agreement refuses by name,
    // naming the agreement currency the operator must bill in.
    await assert.rejects(
      ensureScopedContract(
        db,
        org.orgId,
        { kind: "subscription", id: eurSubscription, number: "Pro plan EUR" },
        org.customerId,
        "USD",
        actor,
      ),
      /bills in EUR/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
