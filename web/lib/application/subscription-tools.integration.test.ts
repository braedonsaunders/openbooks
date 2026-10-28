import test, { before } from "node:test";

before(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
const { SUBSCRIPTION_TOOLS } = await import("../assistant/tools-subscriptions.ts");
const { listUsageMeters } = await import("@openbooks/engine/billing/usage/records");
const { listChannels } = await import("@openbooks/engine/commerce");
const { revenueRecognitionCandidates } = await import("@/app/(app)/revenue/_lib");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;
const ENABLED = {
  subscriptionBilling: true,
  advancedSubscriptions: true,
  usageBilling: true,
  revenueRecognition: true,
  contractCosts: true,
  salesChannels: true,
  multiCurrency: true,
};

function ctxFor(
  orgId: string,
  userId: string,
  permissions: string[],
  allowedSubsidiaryIds: Set<string> | null = null,
): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "Subscription test",
        orgId,
        roles: [{ key: "subscription-role", name: "Subscription role" }],
        envKind: "sandbox",
        productionOrgId: orgId,
        isSuperAdmin: false,
        homeUserId: userId,
        homeOrgId: orgId,
      },
      permissions: new Set(permissions),
      allowedSubsidiaryIds,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

async function setFeatures(orgId: string, features: Record<string, boolean>): Promise<void> {
  const updated = await withBypassContext(() =>
    db.execute(
      sql`
        update orgs set settings = jsonb_set(
          coalesce(settings, '{}'::jsonb), '{features}',
          coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(features)}::jsonb,
          true
        ) where id = ${orgId}
        returning id
      `,
      "objects",
    ),
  );
  assert.equal(updated.length, 1, "the feature update must match the leased organization");
}

function readAssistant(name: string) {
  const tool = SUBSCRIPTION_TOOLS.find((candidate) => candidate.name === name);
  assert.ok(tool, `native subscription read ${name} must be registered`);
  return tool;
}

type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>;

const permissions = [
  "ar.create",
  "ar.read",
  "ar.post",
  "usage.manage",
  "usage.read",
  "usage.bill",
  "channels.manage",
  "channels.read",
];

async function createTestOrg(): Promise<{ org: ScratchOrg; context: ApplicationContext }> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const adminId = await withBypassContext(() => createScratchUser(org.orgId, "Admin", "admin"));
    await setFeatures(org.orgId, ENABLED);
    return { org, context: ctxFor(org.orgId, adminId, permissions) };
  } catch (error) {
    await dropScratchOrg(org.orgId);
    throw error;
  }
}

async function run(ctx: ApplicationContext, name: string, input: Record<string, unknown>) {
  return withOrgContext(ctx.authz.user.orgId, () =>
    executeApplicationTool(applicationTool(name)!, ctx, input),
  );
}

async function createSubscription(org: ScratchOrg, context: ApplicationContext): Promise<string> {
  const plan = (await run(context, "create_subscription_plan", {
    action: "addPlan",
    name: `Usage plan ${randomUUID().slice(0, 8)}`,
    amount: "42.50",
    currency: "CAD",
    interval: "monthly",
    incomeAccountId: org.accounts.revenue,
    idempotencyKey: `subscription-plan-${randomUUID()}`,
  })) as { id: string };
  const subscription = (await run(context, "create_subscription", {
    action: "addSubscription",
    customerId: org.customerId,
    planId: plan.id,
    startOn: org.date,
    firstBillOn: org.date,
    quantity: "2",
    catchUp: { mode: "skip" },
    idempotencyKey: `subscription-${randomUUID()}`,
  })) as { id: string };
  return subscription.id;
}

test(
  "subscription plans and subscriptions can be created, replayed, and read",
  { skip: !DB },
  async () => {
    const { org, context } = await createTestOrg();
    try {
      const planInput = {
        action: "addPlan",
        name: `Usage plan ${randomUUID().slice(0, 8)}`,
        amount: "42.50",
        currency: "CAD",
        interval: "monthly",
        incomeAccountId: org.accounts.revenue,
        idempotencyKey: `subscription-plan-create-${randomUUID()}`,
      };
      const plan = (await run(context, "create_subscription_plan", planInput)) as {
        replayed: boolean;
        id: string;
      };
      assert.equal(plan.replayed, false);
      const replay = (await run(context, "create_subscription_plan", planInput)) as {
        replayed: boolean;
        id: string;
      };
      assert.equal(replay.replayed, true);
      assert.equal(replay.id, plan.id);
      const plans = await readAssistant("list_subscription_plans").execute(
        { activeOnly: false },
        context.authz,
      );
      assert.equal(JSON.stringify(plans).split(plan.id).length - 1, 1);

      const subscription = (await run(context, "create_subscription", {
        action: "addSubscription",
        customerId: org.customerId,
        planId: plan.id,
        startOn: org.date,
        firstBillOn: org.date,
        quantity: "2",
        catchUp: { mode: "skip" },
        idempotencyKey: `subscription-create-${randomUUID()}`,
      })) as { id: string };
      const subscriptions = await readAssistant("list_subscriptions").execute({}, context.authz);
      assert.ok(JSON.stringify(subscriptions).includes(subscription.id));
      const billed = (await run(context, "bill_subscription_now", {
        action: "billNow",
        id: subscription.id,
        idempotencyKey: `subscription-bill-now-${randomUUID()}`,
      })) as { invoiceId: string };
      const billedSubscription = await readAssistant("get_subscription").execute(
        { subscriptionId: subscription.id },
        context.authz,
      );
      assert.ok(JSON.stringify(billedSubscription).includes(billed.invoiceId));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "usage meters, records, and rating runs complete through the application catalog",
  { skip: !DB },
  async () => {
    const { org, context } = await createTestOrg();
    try {
      const subscriptionId = await createSubscription(org, context);
      const usageItemId = randomUUID();
      await withOrgContext(org.orgId, async () => {
        const inserted = await db.execute(
          sql`
          insert into items (id, org_id, kind, name, income_account_id, is_active, custom)
          values (${usageItemId}, ${org.orgId}, 'service', 'Usage billing item',
                  ${org.accounts.revenue}, true, '{}'::jsonb)
          returning id
        `,
          "objects",
        );
        assert.equal(inserted.length, 1);
      });
      const meterInput = {
        key: `requests_${randomUUID().slice(0, 8)}`,
        name: "API requests",
        unit: "request",
        aggregation: "sum",
        itemId: usageItemId,
        idempotencyKey: "usage-meter-create-1",
      };
      const meter = (await run(context, "create_usage_meter", meterInput)) as {
        replayed: boolean;
        meter: { id: string };
      };
      const meterReplay = (await run(context, "create_usage_meter", meterInput)) as {
        replayed: boolean;
        meter: { id: string };
      };
      assert.equal(meterReplay.replayed, true);
      const meters = await withOrgContext(org.orgId, () => listUsageMeters(org.orgId));
      assert.equal(meters.filter((candidate) => candidate.id === meter.meter.id).length, 1);

      const ratingPlan = (await run(context, "create_usage_rating_plan", {
        name: `Rating plan ${randomUUID().slice(0, 8)}`,
        currency: "CAD",
        idempotencyKey: "usage-rating-plan-create-1",
      })) as { plan: { id: string } };
      const ratingVersion = (await run(context, "create_usage_rating_plan_version", {
        planId: ratingPlan.plan.id,
        effectiveFrom: org.date,
        idempotencyKey: "usage-rating-version-create-1",
      })) as { version: { id: string } };
      const periodStart = org.date;
      const periodEnd = "2026-07-31";
      await run(context, "replace_usage_rating_bands", {
        versionId: ratingVersion.version.id,
        bands: [
          {
            meterId: meter.meter.id,
            kind: "graduated",
            seq: 1,
            upToQty: "2",
            unitPrice: "1.25",
          },
          {
            meterId: meter.meter.id,
            kind: "graduated",
            seq: 2,
            upToQty: null,
            unitPrice: "2.50",
          },
        ],
        idempotencyKey: "usage-rating-bands-save-1",
      });
      await run(context, "publish_usage_rating_plan_version", {
        versionId: ratingVersion.version.id,
        idempotencyKey: "usage-rating-version-publish-1",
      });
      const usageLink = (await run(context, "create_subscription_usage_link", {
        subscriptionId,
        customerId: org.customerId,
        planVersionId: ratingVersion.version.id,
        meterIds: [meter.meter.id],
        effectiveFrom: org.date,
        allowOverage: true,
        idempotencyKey: "usage-link-create-1",
      })) as { link: { id: string } };
      await run(context, "ingest_usage_records", {
        records: [
          {
            meterKey: meterInput.key,
            customerId: org.customerId,
            subscriptionId,
            occurredOn: org.date,
            quantity: "3",
            source: "api",
            idempotencyKey: "usage-row-create-1",
          },
        ],
        idempotencyKey: "usage-records-ingest-1",
      });
      const preview = (await run(context, "preview_usage_rating_run", {
        linkId: usageLink.link.id,
        periodStart,
        periodEnd,
      })) as { preview: { totalRated: string } };
      assert.equal(preview.preview.totalRated, "5.0000");
      const committed = (await run(context, "commit_usage_rating_run", {
        linkId: usageLink.link.id,
        periodStart,
        periodEnd,
        idempotencyKey: "usage-rating-run-commit-1",
      })) as { result: { run: { id: string } } };
      const runRead = await run(context, "get_usage_rating_run", {
        runId: committed.result.run.id,
      });
      assert.ok(JSON.stringify(runRead).includes(committed.result.run.id));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "subscription amendments and lifecycle transitions preserve native state",
  { skip: !DB },
  async () => {
    const { org, context } = await createTestOrg();
    try {
      const subscriptionId = await createSubscription(org, context);
      await run(context, "change_subscription", {
        action: "changeSubscription",
        id: subscriptionId,
        quantity: "3",
        idempotencyKey: `subscription-change-${randomUUID()}`,
      });
      await run(context, "suspend_subscription", {
        action: "updateSubscription",
        id: subscriptionId,
        idempotencyKey: `subscription-suspend-${randomUUID()}`,
      });
      const suspended = await readAssistant("get_subscription").execute(
        { subscriptionId },
        context.authz,
      );
      assert.ok(JSON.stringify(suspended).includes("paused"));
      await run(context, "resume_subscription", {
        action: "updateSubscription",
        id: subscriptionId,
        idempotencyKey: `subscription-resume-${randomUUID()}`,
      });
      await run(context, "bill_subscription_now", {
        action: "billNow",
        id: subscriptionId,
        idempotencyKey: `subscription-lifecycle-bill-${randomUUID()}`,
      });
      await run(context, "cancel_subscription", {
        action: "updateSubscription",
        id: subscriptionId,
        canceledOn: "2026-12-15",
        idempotencyKey: `subscription-cancel-${randomUUID()}`,
      });
      const canceled = await readAssistant("get_subscription").execute(
        { subscriptionId },
        context.authz,
      );
      assert.ok(JSON.stringify(canceled).includes("canceled"));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "revenue recognition preview and run use the native recognition read",
  { skip: !DB },
  async () => {
    const { org, context } = await createTestOrg();
    try {
      const preview = await run(context, "preview_revenue_recognition", { asOfDate: org.date });
      assert.equal(preview.ok, true);
      const result = await run(context, "run_revenue_recognition", {
        asOfDate: org.date,
        idempotencyKey: `revenue-recognition-run-${randomUUID()}`,
      });
      assert.equal(result.ok, true);
      const candidates = await withOrgContext(org.orgId, () =>
        revenueRecognitionCandidates(org.orgId, null),
      );
      assert.ok(Array.isArray(candidates));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "sales channels can be created and verified with the native channel read",
  { skip: !DB },
  async () => {
    const { org, context } = await createTestOrg();
    try {
      const result = (await run(context, "create_sales_channel", {
        kind: "shopify",
        name: `Store ${randomUUID().slice(0, 8)}`,
        subsidiaryId: org.subsidiaryId,
        currency: "CAD",
        externalAccount: `${randomUUID().slice(0, 8)}.myshopify.com`,
        idempotencyKey: `channel-create-${randomUUID()}`,
      })) as { channel: { id: string } };
      const channels = await withOrgContext(org.orgId, () => listChannels(org.orgId));
      assert.ok(channels.some((candidate) => candidate.id === result.channel.id));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "permission, feature, and cross-organization refusals fail closed",
  { skip: !DB },
  async () => {
    const { org, context } = await createTestOrg();
    let secondOrg: ScratchOrg | undefined;
    try {
      const subscriptionId = await createSubscription(org, context);
      secondOrg = await withBypassContext(() => createScratchOrg());
      const secondAdminId = await withBypassContext(() =>
        createScratchUser(secondOrg!.orgId, "Admin", "admin"),
      );
      await setFeatures(secondOrg.orgId, ENABLED);
      await assert.rejects(
        run(ctxFor(secondOrg.orgId, secondAdminId, permissions), "update_subscription_billing", {
          action: "updateSubscription",
          id: subscriptionId,
          idempotencyKey: `cross-org-subscription-${randomUUID()}`,
        }),
        /not_found/,
      );
      await assert.rejects(
        run(ctxFor(org.orgId, context.authz.user.id, []), "create_subscription_plan", {
          action: "addPlan",
          name: "Denied plan",
          amount: "42.50",
          interval: "monthly",
          idempotencyKey: `permission-refusal-${randomUUID()}`,
        }),
        /forbidden/,
      );
      await setFeatures(org.orgId, { subscriptionBilling: false });
      await assert.rejects(
        run(context, "create_subscription_plan", {
          action: "addPlan",
          name: "Disabled plan",
          amount: "42.50",
          interval: "monthly",
          idempotencyKey: `feature-off-refusal-${randomUUID()}`,
        }),
        /needs the subscriptionBilling feature/,
      );
    } finally {
      if (secondOrg) await dropScratchOrg(secondOrg.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);
