import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { SessionUser } from "../../../lib/auth";
import type { Authz } from "../../../lib/authz";

/**
 * The receipt drawer labels its primary action from whether an on_submit
 * flow governs customer payments: "Submit for approval" when one does,
 * "Receive & post" otherwise. The loader resolves the flag so the drawer
 * never promises a direct posting a flow will intercept.
 */
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { loadPaymentFlyout } = await import("./payment-flyout");

function authzFor(orgId: string, userId: string): Authz {
  const user: SessionUser = {
    id: userId,
    orgId,
    name: "tester",
    email: `tester-${userId.slice(0, 8)}@scratch.test`,
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
  return { user, permissions: new Set(["*"]), allowedSubsidiaryIds: null };
}

async function setFlowsFeature(orgId: string, on: boolean): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
      update orgs set settings = jsonb_set(
        settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || ${`{"flows":${on}}`}::jsonb, true)
      where id = ${orgId}`),
  );
}

async function seedFlow(orgId: string, trigger: string): Promise<void> {
  const graph = {
    schemaVersion: 1,
    nodes: [
      { id: "t", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger } } },
      {
        id: "g",
        position: { x: 220, y: 0 },
        data: {
          kind: "gate",
          gate: { title: "Approval", assignees: [{ type: "role", role: "approver" }], mode: "any" },
        },
      },
    ],
    edges: [{ id: "e1", source: "t", target: "g", sourceHandle: "next" }],
  };
  await withBypassContext(() =>
    db.execute(sql`
      insert into flows (id, org_id, name, subject_kind, enabled, graph)
      values (${randomUUID()}, ${orgId}, 'Receipt approvals', 'customer_payment', true,
              ${JSON.stringify(graph)}::jsonb)`),
  );
}

async function governedFlag(orgId: string, userId: string): Promise<boolean | undefined> {
  const flyout = await loadPaymentFlyout({
    creating: true,
    kind: "customer_payment",
    orgId,
    userId,
    userRoles: [],
    authz: authzFor(orgId, userId),
  });
  assert.ok(flyout);
  return flyout.payment.governedByFlow;
}

test("a kind with no flow resolves ungoverned", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const userId = randomUUID();
    assert.equal(await governedFlag(org.orgId, userId), false);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an enabled on_submit flow governs its kind", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await setFlowsFeature(org.orgId, true);
    await seedFlow(org.orgId, "on_submit");
    const userId = randomUUID();
    assert.equal(await governedFlag(org.orgId, userId), true);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a flow without an on_submit trigger does not govern posting", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await setFlowsFeature(org.orgId, true);
    await seedFlow(org.orgId, "manual");
    const userId = randomUUID();
    assert.equal(await governedFlag(org.orgId, userId), false);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
