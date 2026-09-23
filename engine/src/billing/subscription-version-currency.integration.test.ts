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
import { billSubscriptionNow } from "./subscription-billing.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

async function seedUsdPlan(org: ScratchOrg, actor: string): Promise<string> {
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
    values (${planId}, ${org.orgId}, 'USD plan', '100.0000', 'USD', 'monthly', 1,
            ${org.accounts.revenue}, true, ${actor})
  `);
  return planId;
}

async function seedSubscription(org: ScratchOrg, actor: string, planId: string): Promise<string> {
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

async function seedVersion(org: ScratchOrg, actor: string, planId: string, currency: string | null): Promise<string> {
  const versionId = await createPlanVersion(org.orgId, actor, {
    planId,
    effectiveFrom: "2026-01-01",
    billingTiming: "advance",
    currency: currency ?? undefined,
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
  return versionId;
}

async function invoiceCurrency(orgId: string, invoiceId: string): Promise<string> {
  return (await db.execute<{ currency: string }>(
    sql`select currency from documents where id = ${invoiceId} and org_id = ${orgId}`,
  )).rows[0]!.currency;
}

async function withOrg(run: (org: ScratchOrg, actor: string) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Version currency controller", "admin");
    await run(org, actor);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

test("a USD to EUR version activates and invoices in EUR", DB, async () => {
  await withOrg(async (org, actor) => {
    const planId = await seedUsdPlan(org, actor);
    const versionId = await seedVersion(org, actor, planId, "EUR");
    const subscriptionId = await seedSubscription(org, actor, planId);
    await activateLifecycle(org.orgId, actor, {
      subscriptionId,
      planVersionId: versionId,
      termStartsOn: "2026-01-01",
      renewalPolicy: "none",
    });
    const billed = await billSubscriptionNow(subscriptionId, "2026-01-15", { actorId: actor });
    assert.equal(await invoiceCurrency(org.orgId, billed.invoiceId), "EUR");
  });
});

test("a mid-term currency change on a billed subscription is refused at activation", DB, async () => {
  await withOrg(async (org, actor) => {
    const planId = await seedUsdPlan(org, actor);
    const subscriptionId = await seedSubscription(org, actor, planId);
    const first = await billSubscriptionNow(subscriptionId, "2026-01-15", { actorId: actor });
    assert.equal(await invoiceCurrency(org.orgId, first.invoiceId), "USD");
    const versionId = await seedVersion(org, actor, planId, "EUR");
    // The new term starts at the unbilled boundary so the activation
    // exercises the currency guard, not the billed-service overlap guard.
    await assert.rejects(
      activateLifecycle(org.orgId, actor, {
        subscriptionId,
        planVersionId: versionId,
        termStartsOn: "2026-02-01",
        renewalPolicy: "none",
      }),
      /cannot change mid-contract/,
    );
    const lifecycles = (await db.execute<{ n: number }>(
      sql`select count(*)::int as n from subscription_lifecycles where org_id = ${org.orgId} and subscription_id = ${subscriptionId}`,
    )).rows[0]!.n;
    assert.equal(lifecycles, 0);
  });
});

test("activating the same-currency version on a billed subscription still works", DB, async () => {
  await withOrg(async (org, actor) => {
    const planId = await seedUsdPlan(org, actor);
    const subscriptionId = await seedSubscription(org, actor, planId);
    await billSubscriptionNow(subscriptionId, "2026-01-15", { actorId: actor });
    const versionId = await seedVersion(org, actor, planId, "USD");
    await activateLifecycle(org.orgId, actor, {
      subscriptionId,
      planVersionId: versionId,
      termStartsOn: "2026-02-01",
      renewalPolicy: "none",
    });
  });
});

test("a version without a currency falls back to the plan currency", DB, async () => {
  await withOrg(async (org, actor) => {
    const planId = await seedUsdPlan(org, actor);
    // Legacy versions can carry no currency of their own; billing then uses
    // the base plan's code rather than failing or guessing. Published
    // versions are trigger-immutable, so the null is set while draft.
    const draftId = await createPlanVersion(org.orgId, actor, {
      planId,
      effectiveFrom: "2026-01-01",
      billingTiming: "advance",
      currency: "EUR",
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
    await db.execute(sql`update subscription_plan_versions set currency_code = null where id = ${draftId} and org_id = ${org.orgId}`);
    await publishPlanVersion(org.orgId, actor, draftId);
    const versionId = draftId;
    const subscriptionId = await seedSubscription(org, actor, planId);
    await activateLifecycle(org.orgId, actor, {
      subscriptionId,
      planVersionId: versionId,
      termStartsOn: "2026-01-01",
      renewalPolicy: "none",
    });
    const billed = await billSubscriptionNow(subscriptionId, "2026-01-15", { actorId: actor });
    assert.equal(await invoiceCurrency(org.orgId, billed.invoiceId), "USD");
  });
});
