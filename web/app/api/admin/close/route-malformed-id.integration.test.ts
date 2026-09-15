import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __closeRouteUser: state });
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/admin/close/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardPermission(){return {user:globalThis.__closeRouteUser.user,permissions:new Set(['*']),allowedSubsidiaryIds:null}} export function guardSubsidiaryScope(){return null}",
          ),
      };
    }
    if (specifier.startsWith("@/")) return next(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    return next(specifier, context);
  },
});
const { POST } = await import("./route");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
hooks.deregister();

const request = (body: unknown) =>
  new Request("http://close.local/api/admin/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("close configuration saves reject malformed ids instead of creating new rows", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Close Admin", "close-admin");
    state.user = { orgId: org.orgId, id: actorId };
    await withBypassContext(() =>
      db.execute(sql`update orgs set settings = settings || '{"features":{"advancedClose":true}}'::jsonb where id = ${org.orgId}`),
    );
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
