import test, { after, before } from "node:test";

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
  await withBypassContext(() =>
    db.execute(sql`
      update orgs set settings = jsonb_set(
        coalesce(settings, '{}'::jsonb), '{features}',
        coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(features)}::jsonb,
        true
      ) where id = ${orgId}
    `),
  );
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
let org: ScratchOrg | null = null;
let secondOrg: ScratchOrg | null = null;
let context: ApplicationContext | null = null;
let subscriptionId: string | null = null;

function currentContext(): ApplicationContext {
  assert.ok(context, "the scratch organization must be initialized");
  return context;
}

async function run(name: string, input: Record<string, unknown>, ctx = currentContext()) {
  return withOrgContext(ctx.authz.user.orgId, () =>
    executeApplicationTool(applicationTool(name)!, ctx, input),
  );
}

before(async () => {
  if (!DB) return;
  org = await withBypassContext(() => createScratchOrg());
  const adminId = await withBypassContext(() => createScratchUser(org!.orgId, "Admin", "admin"));
  await setFeatures(org.orgId, ENABLED);
  context = ctxFor(org.orgId, adminId, permissions);
});

after(async () => {
  if (secondOrg) await dropScratchOrg(secondOrg.orgId);
  if (org) await dropScratchOrg(org.orgId);
});

test(
  "subscription plans and subscriptions can be created, replayed, and read",
  { skip: !DB },
  async () => {
    const currentOrg = org!;
    const actor = currentContext();
    const planInput = {
      action: "addPlan",
      name: "Usage plan " + randomUUID().slice(0, 8),
      amount: "42.50",
      currency: "CAD",
      interval: "monthly",
      incomeAccountId: currentOrg.accounts.revenue,
      idempotencyKey: "subscription-plan-create-1",
    };
    const plan = (await run("create_subscription_plan", planInput)) as {
      replayed: boolean;
      id: string;
    };
    assert.equal(plan.replayed, false);
    const replay = (await run("create_subscription_plan", planInput)) as {
      replayed: boolean;
      id: string;
    };
    assert.equal(replay.replayed, true);
    assert.equal(replay.id, plan.id);
    const plans = await readAssistant("list_subscription_plans").execute(
      { activeOnly: false },
      actor.authz,
    );
    assert.equal(JSON.stringify(plans).split(plan.id).length - 1, 1);

    const subscription = (await run("create_subscription", {
      action: "addSubscription",
      customerId: currentOrg.customerId,
      planId: plan.id,
      startOn: currentOrg.date,
      firstBillOn: currentOrg.date,
      quantity: "2",
      catchUp: { mode: "skip" },
      idempotencyKey: "subscription-create-1",
    })) as { id: string };
    subscriptionId = subscription.id;
    const subscriptions = await readAssistant("list_subscriptions").execute({}, actor.authz);
    assert.ok(JSON.stringify(subscriptions).includes(subscriptionId));
    const billed = (await run("bill_subscription_now", {
      action: "billNow",
      id: subscriptionId,
      idempotencyKey: "subscription-bill-now-1",
    })) as { invoiceId: string };
    const billedSubscription = await readAssistant("get_subscription").execute(
      { subscriptionId },
      actor.authz,
    );
    assert.ok(JSON.stringify(billedSubscription).includes(billed.invoiceId));
  },
);

test(
  "usage meters, records, and rating runs complete through the application catalog",
  { skip: !DB },
  async () => {
    const currentOrg = org!;
    assert.ok(subscriptionId, "the subscription workflow must run first");
    const usageItemId = randomUUID();
    await withOrgContext(currentOrg.orgId, async () => {
      const inserted = await db.execute(
        sql`
        insert into items (id, org_id, kind, name, income_account_id, is_active, custom)
        values (${usageItemId}, ${currentOrg.orgId}, 'service', 'Usage billing item',
                ${currentOrg.accounts.revenue}, true, '{}'::jsonb)
        returning id
      `,
        "objects",
      );
      assert.equal(inserted.length, 1);
    });
    const meterInput = {
      key: "requests_" + randomUUID().slice(0, 8),
      name: "API requests",
      unit: "request",
      aggregation: "sum",
      itemId: usageItemId,
      idempotencyKey: "usage-meter-create-1",
    };
    const meter = (await run("create_usage_meter", meterInput)) as {
      replayed: boolean;
      meter: { id: string };
    };
    const meterReplay = (await run("create_usage_meter", meterInput)) as {
      replayed: boolean;
      meter: { id: string };
    };
    assert.equal(meterReplay.replayed, true);
    const meters = await withOrgContext(currentOrg.orgId, () => listUsageMeters(currentOrg.orgId));
    assert.equal(meters.filter((candidate) => candidate.id === meter.meter.id).length, 1);

    const ratingPlan = (await run("create_usage_rating_plan", {
      name: "Rating plan " + randomUUID().slice(0, 8),
      currency: "CAD",
      idempotencyKey: "usage-rating-plan-create-1",
    })) as { plan: { id: string } };
    const ratingVersion = (await run("create_usage_rating_plan_version", {
      planId: ratingPlan.plan.id,
      effectiveFrom: currentOrg.date,
      idempotencyKey: "usage-rating-version-create-1",
    })) as { version: { id: string } };
    const periodStart = currentOrg.date;
    const periodEnd = "2026-07-31";
    await run("replace_usage_rating_bands", {
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
    await run("publish_usage_rating_plan_version", {
      versionId: ratingVersion.version.id,
      idempotencyKey: "usage-rating-version-publish-1",
    });
    const usageLink = (await run("create_subscription_usage_link", {
      subscriptionId,
      customerId: currentOrg.customerId,
      planVersionId: ratingVersion.version.id,
      meterIds: [meter.meter.id],
      effectiveFrom: currentOrg.date,
      allowOverage: true,
      idempotencyKey: "usage-link-create-1",
    })) as { link: { id: string } };
    await run("ingest_usage_records", {
      records: [
        {
          meterKey: meterInput.key,
          customerId: currentOrg.customerId,
          subscriptionId,
          occurredOn: currentOrg.date,
          quantity: "3",
          source: "api",
          idempotencyKey: "usage-row-create-1",
        },
      ],
      idempotencyKey: "usage-records-ingest-1",
    });
    const preview = (await run("preview_usage_rating_run", {
      linkId: usageLink.link.id,
      periodStart,
      periodEnd,
    })) as { preview: { totalRated: string } };
    assert.equal(preview.preview.totalRated, "5.0000");
    const committed = (await run("commit_usage_rating_run", {
      linkId: usageLink.link.id,
      periodStart,
      periodEnd,
      idempotencyKey: "usage-rating-run-commit-1",
    })) as { result: { run: { id: string } } };
    const runRead = await run("get_usage_rating_run", { runId: committed.result.run.id });
    assert.ok(JSON.stringify(runRead).includes(committed.result.run.id));
  },
);

test(
  "subscription amendments and lifecycle transitions preserve native state",
  { skip: !DB },
  async () => {
    assert.ok(subscriptionId, "the subscription workflow must run first");
    const actor = currentContext();
    await run("change_subscription", {
      action: "changeSubscription",
      id: subscriptionId,
      quantity: "3",
      idempotencyKey: "subscription-change-1",
    });
    await run("suspend_subscription", {
      action: "updateSubscription",
      id: subscriptionId,
      idempotencyKey: "subscription-suspend-1",
    });
    const suspended = await readAssistant("get_subscription").execute(
      { subscriptionId },
      actor.authz,
    );
    assert.ok(JSON.stringify(suspended).includes("paused"));
    await run("resume_subscription", {
      action: "updateSubscription",
      id: subscriptionId,
      idempotencyKey: "subscription-resume-1",
    });
    await run("cancel_subscription", {
      action: "updateSubscription",
      id: subscriptionId,
      canceledOn: "2026-12-15",
      idempotencyKey: "subscription-cancel-1",
    });
    const canceled = await readAssistant("get_subscription").execute(
      { subscriptionId },
      actor.authz,
    );
    assert.ok(JSON.stringify(canceled).includes("canceled"));
  },
);

test(
  "revenue recognition preview and run use the native recognition read",
  { skip: !DB },
  async () => {
    const currentOrg = org!;
    const preview = await run("preview_revenue_recognition", { asOfDate: currentOrg.date });
    assert.equal(preview.ok, true);
    const result = await run("run_revenue_recognition", {
      asOfDate: currentOrg.date,
      idempotencyKey: "revenue-recognition-run-1",
    });
    assert.equal(result.ok, true);
    const candidates = await withOrgContext(currentOrg.orgId, () =>
      revenueRecognitionCandidates(currentOrg.orgId, null),
    );
    assert.ok(Array.isArray(candidates));
  },
);

test(
  "sales channels can be created and verified with the native channel read",
  { skip: !DB },
  async () => {
    const currentOrg = org!;
    const result = (await run("create_sales_channel", {
      kind: "shopify",
      name: "Store " + randomUUID().slice(0, 8),
      subsidiaryId: currentOrg.subsidiaryId,
      currency: "CAD",
      externalAccount: randomUUID().slice(0, 8) + ".myshopify.com",
      idempotencyKey: "channel-create-1",
    })) as { channel: { id: string } };
    const channels = await withOrgContext(currentOrg.orgId, () => listChannels(currentOrg.orgId));
    assert.ok(channels.some((candidate) => candidate.id === result.channel.id));
  },
);

test(
  "permission, feature, and cross-organization refusals fail closed",
  { skip: !DB },
  async () => {
    const currentOrg = org!;
    const actor = currentContext();
    assert.ok(subscriptionId, "the subscription workflow must run first");
    secondOrg = await withBypassContext(() => createScratchOrg());
    const secondAdminId = await withBypassContext(() =>
      createScratchUser(secondOrg!.orgId, "Admin", "admin"),
    );
    await setFeatures(secondOrg.orgId, ENABLED);
    await assert.rejects(
      run(
        "update_subscription_billing",
        {
          action: "updateSubscription",
          id: subscriptionId,
          idempotencyKey: "cross-org-subscription-1",
        },
        ctxFor(secondOrg.orgId, secondAdminId, permissions),
      ),
      /not_found/,
    );
    await assert.rejects(
      run(
        "create_subscription_plan",
        {
          action: "addPlan",
          name: "Denied plan",
          amount: "42.50",
          interval: "monthly",
          idempotencyKey: "permission-refusal-1",
        },
        ctxFor(currentOrg.orgId, actor.authz.user.id, []),
      ),
      /forbidden/,
    );
    await setFeatures(currentOrg.orgId, { subscriptionBilling: false });
    await assert.rejects(
      run("create_subscription_plan", {
        action: "addPlan",
        name: "Disabled plan",
        amount: "42.50",
        interval: "monthly",
        idempotencyKey: "feature-off-refusal-1",
      }),
      /needs the subscriptionBilling feature/,
    );
  },
);
