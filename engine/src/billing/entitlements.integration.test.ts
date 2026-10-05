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
  EntitlementError,
  checkEntitlement,
  createSaasFeature,
  expireSubscriptionOverride,
  getEntitlementSnapshot,
  listPlanVersionEntitlements,
  resolveEntitlements,
  savePlanVersionEntitlements,
  saveSubscriptionOverride,
} from "./entitlements.ts";
import { createUsageMeter } from "./usage/records.ts";
import {
  createSubscriptionUsageLink,
  createUsageRatingPlan,
  createUsageRatingPlanVersion,
  publishUsagePlanVersion,
  replaceUsageRatingBands,
} from "./usage/rating-plans.ts";
import {
  createScratchOrg,
  createScratchUser,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * SaaS plan entitlements: catalog grants per plan version, negotiated
 * per-subscription overrides, one effective-dated resolver with a cached
 * snapshot, overage handling into usage rating, and change announcements.
 * Every proof below reads the stored rows (grants, overrides, snapshots,
 * usage records, notices, webhook events) — never the writer's return
 * value alone.
 */

interface Seed {
  org: ScratchOrg;
  actor: string;
  planId: string;
  versionId: string;
  subscriptionId: string;
}

async function seedEntitlementOrg(): Promise<Seed> {
  const org = await createScratchOrg();
  const actor = await createScratchUser(org.orgId, "Entitlement Owner", "entitlement_owner");
  await db.execute(sql`update users set is_super_admin = true where id = ${actor} and org_id = ${org.orgId}`);
  await db.execute(sql`
    update orgs
       set settings = settings || '{"features":{"subscriptionBilling":true,"advancedSubscriptions":true,"usageBilling":true,"apiAccess":true,"outboundWebhooks":true}}'::jsonb
     where id = ${org.orgId}
  `);
  const planId = randomUUID();
  await db.execute(sql`
    insert into subscription_plans
      (id, org_id, name, amount, currency_code, interval, interval_count,
       income_account_id, is_active, created_by)
    values (${planId}, ${org.orgId}, 'SaaS Plan', '0', 'CAD', 'monthly', 1,
            ${org.accounts.revenue}, true, ${actor})
  `);
  const versionId = await createPlanVersion(org.orgId, actor, {
    planId,
    effectiveFrom: "2026-05-01",
    components: [
      {
        componentKey: "platform",
        name: "Platform fee",
        quantity: "1",
        unitPrice: "100.00",
        incomeAccountId: org.accounts.revenue,
      },
    ],
  }, null);
  const subscriptionId = randomUUID();
  await db.execute(sql`
    insert into subscriptions
      (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on,
       auto_post, created_by)
    values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${planId}, '1', 'active',
            '2026-05-15', '2026-05-15', false, ${actor})
  `);
  return { org, actor, planId, versionId, subscriptionId };
}

async function seedMeteredLink(seed: Seed, meterKey: string): Promise<{ meterId: string }> {
  const { org, actor, subscriptionId } = seed;
  const meter = await createUsageMeter(org.orgId, actor, {
    key: meterKey,
    name: "API calls",
    unit: "calls",
    aggregation: "sum",
    itemId: org.items.service,
  });
  const plan = await createUsageRatingPlan(org.orgId, actor, { name: `Rating ${randomUUID()}`, currency: "CAD" });
  const version = await createUsageRatingPlanVersion(org.orgId, actor, {
    planId: plan.id,
    effectiveFrom: "2026-05-01",
  });
  await replaceUsageRatingBands(org.orgId, actor, version.id, [
    { meterId: meter.id, kind: "graduated", seq: 1, upToQty: null, unitPrice: "0.05" },
  ]);
  const published = await publishUsagePlanVersion(org.orgId, actor, version.id);
  await createSubscriptionUsageLink(org.orgId, actor, {
    subscriptionId,
    customerId: org.customerId,
    planVersionId: published.id,
    meterIds: [meter.id],
    effectiveFrom: "2026-05-15",
  });
  return { meterId: meter.id };
}

async function usageRows(orgId: string, subscriptionId: string, sourceRef: string): Promise<Array<{ id: string; quantity: string; reversesId: string | null; reversed: boolean }>> {
  return (await db.execute(sql`
    select r.id, r.quantity::text as quantity, r.reverses_id as "reversesId",
           exists (select 1 from usage_records v where v.org_id = r.org_id and v.reverses_id = r.id) as reversed
      from usage_records r
     where r.org_id = ${orgId} and r.subscription_id = ${subscriptionId}::uuid and r.source_ref = ${sourceRef}
     order by r.created_at, r.id`)).rows as Array<{ id: string; quantity: string; reversesId: string | null; reversed: boolean }>;
}

test("plan grants resolve by effective date, and history survives the change", { skip: !DB }, async () => {
  const seed = await seedEntitlementOrg();
  const { org, actor, versionId, subscriptionId } = seed;
  await createSaasFeature(org.orgId, actor, { key: "seats_included", name: "Seats", type: "quantity", unit: "seats" });
  // Both grants land while the version is still a draft, so backdated
  // starts are history being written — not history being rewritten.
  await savePlanVersionEntitlements(org.orgId, actor, {
    planVersionId: versionId,
    effectiveFrom: "2026-05-01",
    rows: [{ featureKey: "seats_included", limit: "100" }],
  });
  await savePlanVersionEntitlements(org.orgId, actor, {
    planVersionId: versionId,
    effectiveFrom: "2026-06-01",
    rows: [{ featureKey: "seats_included", limit: "200" }],
  });
  await publishPlanVersion(org.orgId, actor, versionId, null);
  const [early] = await resolveEntitlements(org.orgId, { subscriptionId }, "2026-05-15");
  const [late] = await resolveEntitlements(org.orgId, { subscriptionId }, "2026-07-01");
  assert.equal(early?.features.find((f) => f.featureKey === "seats_included")?.limit, "100");
  assert.equal(late?.features.find((f) => f.featureKey === "seats_included")?.limit, "200");
  const history = await listPlanVersionEntitlements(org.orgId, versionId, "2026-07-01");
  assert.equal(history.length, 1);
  const closed = (await db.execute<{ from: string; to: string | null }>(sql`
    select effective_from::text as "from", effective_to::text as "to"
      from subscription_plan_version_entitlements
     where org_id = ${org.orgId} and plan_version_id = ${versionId}::uuid
     order by effective_from`)).rows;
  assert.deepEqual(closed.map((r) => [r.from, r.to]), [["2026-05-01", "2026-06-01"], ["2026-06-01", null]]);
});

test("a lifecycle pins its version: newer published versions do not move it", { skip: !DB }, async () => {
  const seed = await seedEntitlementOrg();
  const { org, actor, planId, versionId, subscriptionId } = seed;
  await createSaasFeature(org.orgId, actor, { key: "seats_included", name: "Seats", type: "quantity", unit: "seats" });
  await savePlanVersionEntitlements(org.orgId, actor, {
    planVersionId: versionId,
    effectiveFrom: "2026-05-01",
    rows: [{ featureKey: "seats_included", limit: "100" }],
  });
  await publishPlanVersion(org.orgId, actor, versionId, null);
  await activateLifecycle(org.orgId, actor, {
    subscriptionId,
    planVersionId: versionId,
    termStartsOn: "2026-05-15",
    termEndsOn: "2026-12-31",
  });
  const version2 = await createPlanVersion(org.orgId, actor, {
    planId,
    effectiveFrom: "2026-07-01",
    components: [
      {
        componentKey: "platform",
        name: "Platform fee",
        quantity: "1",
        unitPrice: "120.00",
        incomeAccountId: org.accounts.revenue,
      },
    ],
  }, null);
  await savePlanVersionEntitlements(org.orgId, actor, {
    planVersionId: version2,
    effectiveFrom: "2026-07-01",
    rows: [{ featureKey: "seats_included", limit: "50" }],
  });
  await publishPlanVersion(org.orgId, actor, version2, null);
  const [pinned] = await resolveEntitlements(org.orgId, { subscriptionId }, "2026-08-01");
  assert.equal(pinned?.planVersionId, versionId);
  assert.equal(pinned?.grandfathered, true);
  assert.equal(pinned?.features.find((f) => f.featureKey === "seats_included")?.limit, "100");
  // A subscription without a lifecycle follows the newest published version.
  const followerId = randomUUID();
  await db.execute(sql`
    insert into subscriptions
      (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on,
       auto_post, created_by)
    values (${followerId}, ${org.orgId}, ${org.customerId}, ${planId}, '1', 'active',
            '2026-08-01', '2026-08-01', false, ${actor})
  `);
  const [follower] = await resolveEntitlements(org.orgId, { subscriptionId: followerId }, "2026-08-01");
  assert.equal(follower?.planVersionId, version2);
  assert.equal(follower?.grandfathered, false);
  assert.equal(follower?.features.find((f) => f.featureKey === "seats_included")?.limit, "50");
});

test("overrides win field by field, and expiry restores the plan grant", { skip: !DB }, async () => {
  const seed = await seedEntitlementOrg();
  const { org, actor, versionId, subscriptionId } = seed;
  await createSaasFeature(org.orgId, actor, { key: "seats_included", name: "Seats", type: "quantity", unit: "seats" });
  await createSaasFeature(org.orgId, actor, { key: "sso", name: "Single sign-on", type: "boolean" });
  await savePlanVersionEntitlements(org.orgId, actor, {
    planVersionId: versionId,
    effectiveFrom: "2026-05-01",
    rows: [
      { featureKey: "seats_included", limit: "100", overagePolicy: "block" },
      { featureKey: "sso", enabled: false },
    ],
  });
  await publishPlanVersion(org.orgId, actor, versionId, null);
  await saveSubscriptionOverride(org.orgId, actor, {
    subscriptionId,
    featureKey: "seats_included",
    limit: "500",
    reason: "Enterprise negotiation, order form EO-117.",
    effectiveFrom: "2026-05-01",
  });
  const [overridden] = await resolveEntitlements(org.orgId, { subscriptionId }, "2026-07-01");
  const seats = overridden?.features.find((f) => f.featureKey === "seats_included");
  assert.equal(seats?.limit, "500");
  assert.equal(seats?.source, "override");
  // Untouched fields still flow from the plan: the policy was not overridden.
  assert.equal(seats?.overagePolicy, "block");
  const sso = overridden?.features.find((f) => f.featureKey === "sso");
  assert.equal(sso?.enabled, false);
  // The override announces itself on the subscriber channel.
  const events = (await db.execute<{ type: string; subscriptionId: string; featureKey: string }>(sql`
    select event_type as type, payload->>'subscriptionId' as "subscriptionId", payload->>'featureKey' as "featureKey"
      from webhook_events
     where org_id = ${org.orgId} and event_type = 'entitlement.changed'`)).rows;
  assert.ok(events.some((e) => e.subscriptionId === subscriptionId && e.featureKey === "seats_included"));
  await expireSubscriptionOverride(org.orgId, actor, {
    subscriptionId, featureKey: "seats_included", effectiveTo: "2026-07-15",
  });
  // History keeps the override while it was open; the plan returns after.
  const [covered] = await resolveEntitlements(org.orgId, { subscriptionId }, "2026-07-01");
  assert.equal(covered?.features.find((f) => f.featureKey === "seats_included")?.limit, "500");
  const [restored] = await resolveEntitlements(org.orgId, { subscriptionId }, "2026-08-01");
  assert.equal(restored?.features.find((f) => f.featureKey === "seats_included")?.limit, "100");
  assert.equal(restored?.features.find((f) => f.featureKey === "seats_included")?.source, "plan");
});

test("block refuses over the limit with the limit attached, and writes nothing", { skip: !DB }, async () => {
  const seed = await seedEntitlementOrg();
  const { org, actor, versionId, subscriptionId } = seed;
  await createSaasFeature(org.orgId, actor, { key: "seats_included", name: "Seats", type: "quantity", unit: "seats" });
  await savePlanVersionEntitlements(org.orgId, actor, {
    planVersionId: versionId,
    effectiveFrom: "2026-05-01",
    rows: [{ featureKey: "seats_included", limit: "100", overagePolicy: "block" }],
  });
  await publishPlanVersion(org.orgId, actor, versionId, null);
  const verdict = await checkEntitlement(org.orgId, actor, {
    subscriptionId,
    featureKey: "seats_included",
    used: "125",
    occurredOn: org.date,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.limit, "100");
  assert.equal(verdict.overage, "25");
  assert.equal(verdict.usageRecordId, null);
  const rows = await usageRows(org.orgId, subscriptionId, `entitlement-overage:${subscriptionId}:seats_included:2026-07`);
  assert.equal(rows.length, 0);
});

test("allow_and_bill records the overage for rating, exactly once per reading", { skip: !DB }, async () => {
  const seed = await seedEntitlementOrg();
  const { org, actor, versionId, subscriptionId } = seed;
  await seedMeteredLink(seed, "api_calls");
  await createSaasFeature(org.orgId, actor, {
    key: "api_calls", name: "API calls", type: "metered", unit: "calls", meterKey: "api_calls",
  });
  await savePlanVersionEntitlements(org.orgId, actor, {
    planVersionId: versionId,
    effectiveFrom: "2026-05-01",
    rows: [{ featureKey: "api_calls", limit: "1000", overagePolicy: "allow_and_bill" }],
  });
  await publishPlanVersion(org.orgId, actor, versionId, null);
  const ref = `entitlement-overage:${subscriptionId}:api_calls:2026-07`;
  const first = await checkEntitlement(org.orgId, actor, {
    subscriptionId, featureKey: "api_calls", used: "1200", occurredOn: org.date,
  });
  assert.equal(first.allowed, true);
  assert.equal(first.overage, "200");
  assert.ok(first.usageRecordId);
  assert.equal(first.replayed, false);
  // The identical reading replays the same usage row instead of billing twice.
  const replay = await checkEntitlement(org.orgId, actor, {
    subscriptionId, featureKey: "api_calls", used: "1200", occurredOn: org.date,
  });
  assert.equal(replay.usageRecordId, first.usageRecordId);
  assert.equal(replay.replayed, true);
  // A higher reading supersedes: the old row is reversed, the new row bills.
  const higher = await checkEntitlement(org.orgId, actor, {
    subscriptionId, featureKey: "api_calls", used: "1300", occurredOn: org.date,
  });
  assert.equal(higher.overage, "300");
  assert.notEqual(higher.usageRecordId, first.usageRecordId);
  const rows = await usageRows(org.orgId, subscriptionId, ref);
  const live = rows.filter((r) => r.reversesId === null && !r.reversed);
  assert.equal(live.length, 1);
  assert.equal(live[0]?.id, higher.usageRecordId);
  assert.equal(Number(live[0]?.quantity), 300);
});

test("alert allows the usage and notifies billing operators once", { skip: !DB }, async () => {
  const seed = await seedEntitlementOrg();
  const { org, actor, versionId, subscriptionId } = seed;
  await createSaasFeature(org.orgId, actor, { key: "seats_included", name: "Seats", type: "quantity", unit: "seats" });
  await savePlanVersionEntitlements(org.orgId, actor, {
    planVersionId: versionId,
    effectiveFrom: "2026-05-01",
    rows: [{ featureKey: "seats_included", limit: "100", overagePolicy: "alert" }],
  });
  await publishPlanVersion(org.orgId, actor, versionId, null);
  const verdict = await checkEntitlement(org.orgId, actor, {
    subscriptionId, featureKey: "seats_included", used: "140", occurredOn: org.date,
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.overage, "40");
  const notices = (await db.execute<{ title: string; body: string }>(sql`
    select title, body from notifications
     where org_id = ${org.orgId} and user_id = ${actor} and kind = 'entitlement-overage'
       and href = ${`/collections?subscription=${subscriptionId}&feature=seats_included`} and read_at is null`)).rows;
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.title, /seats_included/);
  assert.match(notices[0]!.body, /override/);
  // A second overage while the notice is unread does not stack another.
  await checkEntitlement(org.orgId, actor, {
    subscriptionId, featureKey: "seats_included", used: "150", occurredOn: org.date,
  });
  const again = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from notifications
     where org_id = ${org.orgId} and user_id = ${actor} and kind = 'entitlement-overage'
       and href = ${`/collections?subscription=${subscriptionId}&feature=seats_included`} and read_at is null`)).rows[0]?.n;
  assert.equal(again, 1);
});

test("the snapshot serves the fast path and refreshes on change", { skip: !DB }, async () => {
  const seed = await seedEntitlementOrg();
  const { org, actor, versionId, subscriptionId } = seed;
  await createSaasFeature(org.orgId, actor, { key: "seats_included", name: "Seats", type: "quantity", unit: "seats" });
  await savePlanVersionEntitlements(org.orgId, actor, {
    planVersionId: versionId,
    effectiveFrom: "2026-05-01",
    rows: [{ featureKey: "seats_included", limit: "100" }],
  });
  await publishPlanVersion(org.orgId, actor, versionId, null);
  const first = await getEntitlementSnapshot(org.orgId, subscriptionId);
  assert.equal(first.features.find((f) => f.featureKey === "seats_included")?.limit, "100");
  const second = await getEntitlementSnapshot(org.orgId, subscriptionId);
  assert.equal(second.resolvedAt, first.resolvedAt);
  assert.equal(second.sourceHash, first.sourceHash);
  await saveSubscriptionOverride(org.orgId, actor, {
    subscriptionId, featureKey: "seats_included", limit: "250", reason: "Capacity uplift for launch week.",
  });
  const third = await getEntitlementSnapshot(org.orgId, subscriptionId);
  assert.equal(third.features.find((f) => f.featureKey === "seats_included")?.limit, "250");
  assert.notEqual(third.sourceHash, first.sourceHash);
});

test("unknown features and empty overrides refuse by name", { skip: !DB }, async () => {
  const seed = await seedEntitlementOrg();
  const { org, actor, subscriptionId } = seed;
  await assert.rejects(
    checkEntitlement(org.orgId, actor, { subscriptionId, featureKey: "nope", used: "1", occurredOn: org.date }),
    (error: unknown) => error instanceof EntitlementError && error.code === "entitlement_feature_not_found",
  );
  await createSaasFeature(org.orgId, actor, { key: "seats_included", name: "Seats", type: "quantity", unit: "seats" });
  await assert.rejects(
    saveSubscriptionOverride(org.orgId, actor, {
      subscriptionId, featureKey: "seats_included", reason: "Nothing actually changed.",
    }),
    (error: unknown) => error instanceof EntitlementError && error.code === "entitlement_override_empty",
  );
  await assert.rejects(
    expireSubscriptionOverride(org.orgId, actor, { subscriptionId, featureKey: "seats_included" }),
    (error: unknown) => error instanceof EntitlementError && error.code === "entitlement_override_not_found",
  );
});
