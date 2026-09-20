import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Close configuration saves coerce isActive with `!== false` while every
// sibling flag in the same file uses the strict `bool()` helper (`=== true`).
// A mistyped isActive: "false" (or 0, or "yes") therefore ACTIVATES the row
// with a 200 instead of failing closed — a live automation or reporting
// package the admin tried to switch off keeps running. Same boolean-flag
// class the fleet closed on project-types PATCH (w13) and
// form-layouts/pdf-templates/list-views/projects PATCH.

const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __closeFlagsUser: state });
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/admin/close/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardPermission(){return {user:globalThis.__closeFlagsUser.user,permissions:new Set(['*']),allowedSubsidiaryIds:null}} export function guardSubsidiaryScope(){return null}",
          ),
      };
    }
    if (specifier.startsWith("@/")) return next(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    return next(specifier, context);
  },
});
const { POST } = await import("./route");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
hooks.deregister();

const request = (body: unknown) =>
  new Request("http://close.local/api/admin/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function setup() {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Close Flags Admin", "close-admin");
  state.user = { orgId: org.orgId, id: actorId };
  await withBypassContext(() =>
    db.execute(sql`update orgs set settings = settings || '{"features":{"advancedClose":true}}'::jsonb where id = ${org.orgId}`),
  );
  return { org, actorId };
}

test("close saves refuse a non-boolean isActive without writing", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
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
        rules: {},
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
      assert.equal(response.status, 422, `${body.action}: expected 422, got ${response.status}: ${await response.text()}`);
    }
    const counts = await withBypassContext(() => db.execute<{ calendars: number; policies: number; automations: number; packages: number }>(sql`
      select
        (select count(*)::int from fiscal_calendars where org_id = ${org.orgId} and name = 'Flags Calendar') as calendars,
        (select count(*)::int from close_policies where org_id = ${org.orgId} and code = 'flags-policy') as policies,
        (select count(*)::int from close_automation_rules where org_id = ${org.orgId} and name = 'Flags Automation') as automations,
        (select count(*)::int from close_reporting_packages where org_id = ${org.orgId} and name = 'Flags Package') as packages`));
    assert.deepEqual(counts.rows[0], { calendars: 0, policies: 0, automations: 0, packages: 0 });
  } finally {
    state.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});

test("close saves still accept real booleans for isActive", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await setup();
  try {
    const off = await withOrgContext(org.orgId, () => POST(request({
      action: "save-calendar",
      name: "Inactive Calendar",
      cadence: "monthly",
      yearStartMonth: 1,
      isActive: false,
    })));
    assert.equal(off.status, 200, await off.text());
    const row = await withBypassContext(() => db.execute<{ is_active: boolean }>(sql`
      select is_active from fiscal_calendars where org_id = ${org.orgId} and name = 'Inactive Calendar'`));
    assert.equal(row.rows[0]?.is_active, false);

    const on = await withOrgContext(org.orgId, () => POST(request({
      action: "save-automation",
      name: "Active Automation",
      trigger: "run_started",
      automationAction: "notify",
      isActive: true,
    })));
    assert.equal(on.status, 200, await on.text());
  } finally {
    state.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});
