import assert from "node:assert/strict";
import { stubModules, withAuthzTestSurface } from "../../../../testing/stub-modules";
import test from "node:test";
import { sql } from "drizzle-orm";

// Configuration boundaries refuse ambiguous flags before any writes.

const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __closeFlagsUser: state });
stubModules({
  navigation: true,
  authz: {
    source: withAuthzTestSurface(
      "export async function guardPermission(){return {user:globalThis.__closeFlagsUser.user,permissions:new Set(['*']),allowedSubsidiaryIds:null}} export function guardSubsidiaryScope(){return null}",
    ),
  },
  features: false,
});
const { POST } = await import("./route");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const request = (body: unknown) =>
  new Request("http://close.local/api/admin/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function setup() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() =>
    createScratchUser(org.orgId, "Close Flags Admin", "close-admin"),
  );
  state.user = { orgId: org.orgId, id: actorId };
  const enabled = await withBypassContext(() =>
    db.execute<{ id: string }>(
      sql`update orgs set settings = settings || '{"features":{"advancedClose":true}}'::jsonb where id = ${org.orgId} returning id`,
      "objects",
    ),
  );
  assert.equal(enabled.length, 1, "close flags setup updates exactly one organization");
  assert.equal(enabled[0]?.id, org.orgId, "close flags setup updates its own organization");
  return { org, actorId };
}

test("close saves refuse a non-boolean isActive without writing", async () => {
  const { org } = await setup();
  try {
    const cases = [
      {
        action: "save-calendar",
        name: "Flags Calendar",
        cadence: "monthly",
        yearStartMonth: 1,
        isActive: "false",
      },
      {
        action: "save-policy",
        code: "flags-policy",
        name: "Flags policy",
        policyType: "materiality",
        rules: { amount: "1000.0000", percent: 20 },
        isActive: 0,
      },
      {
        action: "save-automation",
        name: "Flags Automation",
        trigger: "run_started",
        automationAction: "notify",
        isActive: "yes",
      },
      {
        action: "save-package",
        name: "Flags Package",
        reports: [{ slug: "trial-balance" }],
        isActive: "false",
      },
    ];
    for (const body of cases) {
      const response = await withOrgContext(org.orgId, () => POST(request(body)));
      assert.equal(
        response.status,
        422,
        `${body.action}: expected 422, got ${response.status}: ${await response.text()}`,
      );
    }
    const counts = await withBypassContext(() =>
      db.execute<{ calendars: number; policies: number; automations: number; packages: number }>(
        sql`
      select
        (select count(*)::int from fiscal_calendars where org_id = ${org.orgId} and name = 'Flags Calendar') as calendars,
        (select count(*)::int from close_policies where org_id = ${org.orgId} and code = 'flags-policy') as policies,
        (select count(*)::int from close_automation_rules where org_id = ${org.orgId} and name = 'Flags Automation') as automations,
        (select count(*)::int from close_reporting_packages where org_id = ${org.orgId} and name = 'Flags Package') as packages`,
        "objects",
      ),
    );
    assert.deepEqual(counts[0], { calendars: 0, policies: 0, automations: 0, packages: 0 });
  } finally {
    state.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});

test("close saves still accept real booleans for isActive", async () => {
  const { org } = await setup();
  try {
    const off = await withOrgContext(org.orgId, () =>
      POST(
        request({
          action: "save-calendar",
          name: "Inactive Calendar",
          cadence: "monthly",
          yearStartMonth: 1,
          isActive: false,
        }),
      ),
    );
    assert.equal(off.status, 200, await off.text());
    const row = await withBypassContext(() =>
      db.execute<{ is_active: boolean }>(
        sql`
      select is_active from fiscal_calendars where org_id = ${org.orgId} and name = 'Inactive Calendar'`,
        "objects",
      ),
    );
    assert.equal(row[0]?.is_active, false);

    const on = await withOrgContext(org.orgId, () =>
      POST(
        request({
          action: "save-automation",
          name: "Active Automation",
          trigger: "run_started",
          automationAction: "notify",
          isActive: true,
        }),
      ),
    );
    assert.equal(on.status, 200, await on.text());
  } finally {
    state.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});

test("close configuration cannot introduce approval authority outside Flows", async () => {
  const { org, actorId } = await setup();
  try {
    const step = {
      key: "review",
      title: "Review close evidence",
      workstream: "review",
      taskType: "approval",
      completionMode: "manual",
    };
    const cases = [
      {
        action: "save-blueprint",
        name: "Refused reviewer blueprint",
        steps: [{ ...step, defaultReviewerRoleKey: "controller" }],
      },
      ...["reviewerUserId", "reviewerRoleKey"].map((key) => ({
        action: "save-automation",
        name: "Refused reviewer assignment",
        trigger: "task_ready",
        automationAction: "assign",
        config: { [key]: key === "reviewerUserId" ? actorId : "controller" },
      })),
      ...["review", "segregation"].map((policyType) => ({
        action: "save-policy",
        code: "refused-approval-policy",
        name: "Refused approval policy",
        policyType,
        rules: { prohibitSelfApproval: true },
      })),
    ];
    for (const body of cases) {
      const response = await withOrgContext(org.orgId, () => POST(request(body)));
      assert.equal(response.status, 422, await response.text());
    }
    const counts = await withBypassContext(() =>
      db.execute(
        sql`select
      (select count(*)::int from close_blueprints where org_id=${org.orgId} and name='Refused reviewer blueprint') as blueprints,
      (select count(*)::int from close_automation_rules where org_id=${org.orgId} and name='Refused reviewer assignment') as automations,
      (select count(*)::int from close_policies where org_id=${org.orgId} and code='refused-approval-policy') as policies`,
        "objects",
      ),
    );
    assert.deepEqual(counts[0], { blueprints: 0, automations: 0, policies: 0 });
    const owner = await withOrgContext(org.orgId, () =>
      POST(
        request({
          action: "save-automation",
          name: "Preparation assignment",
          trigger: "task_ready",
          automationAction: "assign",
          config: { ownerUserId: actorId },
        }),
      ),
    );
    assert.equal(owner.status, 200, await owner.text());
  } finally {
    state.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});
