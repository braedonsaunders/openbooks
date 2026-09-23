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
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

async function seedPlan(org: ScratchOrg, actor: string): Promise<string> {
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
    values (${planId}, ${org.orgId}, 'Optional plan', '0', 'CAD', 'monthly', 1,
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

async function withOrg(run: (org: ScratchOrg, actor: string) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Optional component controller", "admin");
    await run(org, actor);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

test("publishing an all-optional version refuses and leaves the draft unpublished", DB, async () => {
  await withOrg(async (org, actor) => {
    const planId = await seedPlan(org, actor);
    const versionId = await createPlanVersion(org.orgId, actor, {
      planId,
      effectiveFrom: "2026-01-01",
      components: [
        { componentKey: "addon", name: "Add-on", unitPrice: "10.0000", incomeAccountId: org.accounts.revenue, isOptional: true },
      ],
    });
    await assert.rejects(publishPlanVersion(org.orgId, actor, versionId), /at least one required component/);
    const status = (await db.execute<{ status: string }>(
      sql`select status from subscription_plan_versions where id = ${versionId} and org_id = ${org.orgId}`,
    )).rows[0]!.status;
    assert.equal(status, "draft");
  });
});

test("a version with a required component still publishes", DB, async () => {
  await withOrg(async (org, actor) => {
    const planId = await seedPlan(org, actor);
    const versionId = await createPlanVersion(org.orgId, actor, {
      planId,
      effectiveFrom: "2026-01-01",
      components: [
        { componentKey: "base", name: "Base", unitPrice: "100.0000", incomeAccountId: org.accounts.revenue },
        { componentKey: "addon", name: "Add-on", unitPrice: "10.0000", incomeAccountId: org.accounts.revenue, isOptional: true },
      ],
    });
    await publishPlanVersion(org.orgId, actor, versionId);
    const subscriptionId = await seedSubscription(org, actor, planId);
    await activateLifecycle(org.orgId, actor, {
      subscriptionId,
      planVersionId: versionId,
      termStartsOn: "2026-01-01",
      renewalPolicy: "none",
    });
    const components = (await db.execute<{ n: number }>(
      sql`select count(*)::int as n from subscription_components where org_id = ${org.orgId} and subscription_id = ${subscriptionId}`,
    )).rows[0]!.n;
    assert.equal(components, 1);
  });
});

test("activating a legacy all-optional published version refuses with nothing written", DB, async () => {
  await withOrg(async (org, actor) => {
    const planId = await seedPlan(org, actor);
    // A version published before the publish guard existed: all optional,
    // already published. Activation must refuse it rather than leave a
    // subscription with zero billable components.
    const versionId = await createPlanVersion(org.orgId, actor, {
      planId,
      effectiveFrom: "2026-01-01",
      components: [
        { componentKey: "addon", name: "Add-on", unitPrice: "10.0000", incomeAccountId: org.accounts.revenue, isOptional: true },
      ],
    });
    await db.execute(sql`update subscription_plan_versions set status = 'published', published_at = now(), published_by = ${actor} where id = ${versionId} and org_id = ${org.orgId}`);
    const subscriptionId = await seedSubscription(org, actor, planId);
    await assert.rejects(
      activateLifecycle(org.orgId, actor, {
        subscriptionId,
        planVersionId: versionId,
        termStartsOn: "2026-01-01",
        renewalPolicy: "none",
      }),
      /no required components/,
    );
    const written = (await db.execute<{ lifecycles: number; components: number }>(sql`
      select (select count(*)::int from subscription_lifecycles where org_id = ${org.orgId} and subscription_id = ${subscriptionId}) as lifecycles,
             (select count(*)::int from subscription_components where org_id = ${org.orgId} and subscription_id = ${subscriptionId}) as components
    `)).rows[0]!;
    assert.deepEqual(written, { lifecycles: 0, components: 0 });
  });
});
