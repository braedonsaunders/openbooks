import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { stubModules, withAuthzTestSurface } from "../../../../testing/stub-modules";
import test from "node:test";
import { sql } from "drizzle-orm";

const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __closeRouteUser: state });
stubModules({
  navigation: true,
  authz: {
    source: withAuthzTestSurface("export async function guardPermission(){return {user:globalThis.__closeRouteUser.user,permissions:new Set(['*']),allowedSubsidiaryIds:null}} export function guardSubsidiaryScope(){return null}"),
  },
  features: false,
});
const { POST } = await import("./route");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const request = (body: unknown) =>
  new Request("http://close.local/api/admin/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function enableAdvancedClose(orgId: string) {
  const enabled = await withBypassContext(() => db.execute<{ id: string }>(sql`
    update orgs set settings = settings || '{"features":{"advancedClose":true}}'::jsonb
     where id = ${orgId} returning id`));
  assert.equal(enabled.rows.length, 1, "close audit setup updates exactly one organization");
  assert.equal(enabled.rows[0]?.id, orgId, "close audit setup updates its own organization");
}

async function setupCloseActor(name: string, role: string, enableFeature = true) {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, name, role));
    state.user = { orgId: org.orgId, id: actorId };
    if (enableFeature) await enableAdvancedClose(org.orgId);
    return org;
  } catch (error) {
    await dropScratchOrg(org.orgId);
    throw error;
  }
}

test("close fixture setup remains observable after the route import and refuses a zero-row update", async () => {
  const org = await setupCloseActor("Scoped Close Admin", "close-admin");
  try {
    const settings = await withOrgContext(org.orgId, () => db.execute<{ enabled: boolean }>(sql`
      select settings #>> '{features,advancedClose}' = 'true' as enabled
        from orgs where id = ${org.orgId}`));
    assert.equal(settings.rows[0]?.enabled, true, "the constrained tenant read sees the fixture feature update");
    await assert.rejects(enableAdvancedClose(randomUUID()), /close audit setup updates exactly one organization/);
  } finally {
    state.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});

test("close configuration saves reject malformed ids instead of creating new rows", async () => {
  const org = await setupCloseActor("Close Admin", "close-admin");
  try {
    const cases = [
      {
        action: "save-calendar",
        name: "Malformed Calendar",
        cadence: "monthly",
        yearStartMonth: 1,
        isDefault: false,
      },
      {
        action: "save-blueprint",
        name: "Malformed Blueprint",
        periodType: "any",
        steps: [{ key: "close", title: "Close", workstream: "gl", taskType: "check", completionMode: "manual", gateType: "none" }],
      },
      {
        action: "save-automation",
        name: "Malformed Automation",
        trigger: "run_started",
        automationAction: "notify",
      },
      {
        action: "save-package",
        name: "Malformed Package",
        reports: [],
      },
    ];
    for (const body of cases) {
      const response = await withOrgContext(org.orgId, () => POST(request({ ...body, id: "not-a-uuid" })));
      assert.equal(response.status, 422, `${body.action}: ${await response.text()}`);
    }
    const counts = await withBypassContext(() => db.execute<{ calendars: number; blueprints: number; automations: number; packages: number }>(sql`
      select
        (select count(*)::int from fiscal_calendars where org_id = ${org.orgId} and name = 'Malformed Calendar') as calendars,
        (select count(*)::int from close_blueprints where org_id = ${org.orgId} and name = 'Malformed Blueprint') as blueprints,
        (select count(*)::int from close_automation_rules where org_id = ${org.orgId} and name = 'Malformed Automation') as automations,
        (select count(*)::int from close_reporting_packages where org_id = ${org.orgId} and name = 'Malformed Package') as packages`));
    assert.deepEqual(counts.rows[0], { calendars: 0, blueprints: 0, automations: 0, packages: 0 });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("close policy saves emit one audit event for each mutation", async () => {
  const org = await setupCloseActor("Close Policy Admin", "close-policy-admin");
  try {
    const create = await withOrgContext(org.orgId, () => POST(request({
      action: "save-policy",
      code: "materiality-policy",
      name: "Materiality policy",
      description: "Initial policy",
      policyType: "materiality",
      rules: { amount: "1000.0000", percent: 20 },
      isActive: true,
    })));
    if (create.status !== 200) throw new Error(`create policy failed: ${await create.text()}`);

    const update = await withOrgContext(org.orgId, () => POST(request({
      action: "save-policy",
      code: "materiality-policy",
      name: "Updated materiality policy",
      description: "Updated policy",
      policyType: "materiality",
      rules: { amount: "2000.0000", percent: 20 },
      isActive: true,
    })));
    if (update.status !== 200) throw new Error(`update policy failed: ${await update.text()}`);

    const audit = await withOrgContext(org.orgId, () => db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from audit_log
       where org_id = ${org.orgId}
         and table_name = 'close_policies'
         and action in ('insert', 'update')`));
    assert.equal(audit.rows[0]?.count, 2);
  } finally {
    state.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});

test("close automation saves emit one audit event for each mutation", async () => {
  const org = await setupCloseActor("Close Automation Admin", "close-automation-admin");
  try {
    const create = await withOrgContext(org.orgId, () => POST(request({
      action: "save-automation",
      name: "Notify on close run",
      trigger: "run_started",
      automationAction: "notify",
      conditions: { severity: "high" },
      config: { channel: "email" },
      isActive: true,
    })));
    if (create.status !== 200) throw new Error(`create automation failed: ${await create.text()}`);
    const automationId = (await create.json()).id as string;

    const update = await withOrgContext(org.orgId, () => POST(request({
      action: "save-automation",
      id: automationId,
      name: "Notify on completed close run",
      trigger: "run_closed",
      automationAction: "notify",
      conditions: { severity: "critical" },
      config: { channel: "email" },
      isActive: true,
    })));
    if (update.status !== 200) throw new Error(`update automation failed: ${await update.text()}`);

    const audit = await withOrgContext(org.orgId, () => db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from audit_log
       where org_id = ${org.orgId}
         and table_name = 'close_automation_rules'
         and row_id = ${automationId}
         and action in ('insert', 'update')`));
    assert.equal(audit.rows[0]?.count, 2);
  } finally {
    state.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});

test("close calendar saves emit one audit event for each mutation", async () => {
  const org = await setupCloseActor("Close Calendar Admin", "close-calendar-admin", false);
  try {
    const create = await withOrgContext(org.orgId, () => POST(request({
      action: "save-calendar",
      name: "Audit calendar",
      cadence: "monthly",
      yearStartMonth: 1,
      weekStartsOn: 1,
      isDefault: false,
      isActive: true,
    })));
    if (create.status !== 200) throw new Error(`create calendar failed: ${await create.text()}`);
    const calendarId = (await create.json()).id as string;

    const update = await withOrgContext(org.orgId, () => POST(request({
      action: "save-calendar",
      id: calendarId,
      name: "Updated audit calendar",
      cadence: "monthly",
      yearStartMonth: 1,
      weekStartsOn: 1,
      isDefault: false,
      isActive: true,
    })));
    if (update.status !== 200) throw new Error(`update calendar failed: ${await update.text()}`);

    const audit = await withOrgContext(org.orgId, () => db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from audit_log
       where org_id = ${org.orgId}
         and table_name = 'fiscal_calendars'
         and row_id = ${calendarId}
         and action in ('insert', 'update')`));
    assert.equal(audit.rows[0]?.count, 2);
  } finally {
    state.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});

test("close blueprint saves emit audit evidence for versioned mutations", async () => {
  const org = await setupCloseActor("Close Blueprint Admin", "close-blueprint-admin");
  try {
    const create = await withOrgContext(org.orgId, () => POST(request({
      action: "save-blueprint",
      name: "Audit blueprint",
      periodType: "any",
      steps: [{ key: "review", title: "Review", workstream: "review", taskType: "check", completionMode: "manual", gateType: "none" }],
    })));
    if (create.status !== 200) throw new Error(`create blueprint failed: ${await create.text()}`);
    const blueprintId = (await create.json()).id as string;

    const update = await withOrgContext(org.orgId, () => POST(request({
      action: "save-blueprint",
      id: blueprintId,
      name: "Updated audit blueprint",
      periodType: "any",
      steps: [{ key: "review", title: "Updated review", workstream: "review", taskType: "check", completionMode: "manual", gateType: "none" }],
    })));
    if (update.status !== 200) throw new Error(`update blueprint failed: ${await update.text()}`);

    const audit = await withOrgContext(org.orgId, () => db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from audit_log
       where org_id = ${org.orgId}
         and table_name = 'close_blueprints'
         and action in ('insert', 'update')`));
    // The update versions the source row, so create + source deactivation + new version are three mutations.
    assert.equal(audit.rows[0]?.count, 3);
  } finally {
    state.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});

test("close reporting-package saves emit one audit event for each mutation", async () => {
  const org = await setupCloseActor("Close Package Admin", "close-package-admin");
  try {
    const create = await withOrgContext(org.orgId, () => POST(request({
      action: "save-package",
      name: "Audit package",
      description: "Initial package",
      reports: [{ slug: "trial-balance" }],
      recipients: ["close@example.test"],
      delivery: { format: "pdf" },
      isDefault: false,
      isActive: true,
    })));
    if (create.status !== 200) throw new Error(`create package failed: ${await create.text()}`);
    const packageId = (await create.json()).id as string;

    const update = await withOrgContext(org.orgId, () => POST(request({
      action: "save-package",
      id: packageId,
      name: "Updated audit package",
      description: "Updated package",
      reports: [{ slug: "trial-balance" }, { slug: "income-statement" }],
      recipients: ["controller@example.test"],
      delivery: { format: "xlsx" },
      isDefault: false,
      isActive: true,
    })));
    if (update.status !== 200) throw new Error(`update package failed: ${await update.text()}`);

    const audit = await withOrgContext(org.orgId, () => db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from audit_log
       where org_id = ${org.orgId}
         and table_name = 'close_reporting_packages'
         and row_id = ${packageId}
         and action in ('insert', 'update')`));
    assert.equal(audit.rows[0]?.count, 2);
  } finally {
    state.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});
