import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Posting-period resolution reads the org's ACTIVE DEFAULT fiscal calendar,
// so an org left with periods but no active default has every posting
// refused. save-calendar must therefore refuse (rolling back) any write
// that strands periods that way, and switching the default must be a
// single atomic swap through the same endpoint.

const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __defaultGuardUser: state });
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/admin/close/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardPermission(){return {user:globalThis.__defaultGuardUser.user,permissions:new Set(['*']),allowedSubsidiaryIds:null}} export function guardSubsidiaryScope(){return null}",
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
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Default Guard Admin", "close-admin"));
  state.user = { orgId: org.orgId, id: actorId };
  await withBypassContext(() =>
    db.execute(sql`update orgs set settings = settings || '{"features":{"advancedClose":true}}'::jsonb where id = ${org.orgId}`),
  );
  const calendar = await withBypassContext(() => db.execute<{ id: string }>(sql`
    select id from fiscal_calendars where org_id = ${org.orgId} and is_default`));
  assert.ok(calendar.rows[0]?.id, "fixture needs a default calendar");
  return { org, defaultCalendarId: calendar.rows[0].id };
}

async function defaults(orgId: string) {
  const rows = await withBypassContext(() => db.execute<{ id: string; is_active: boolean }>(sql`
    select id, is_active from fiscal_calendars where org_id = ${orgId} and is_default`));
  return rows.rows;
}

test("save-calendar refuses to unset the default while periods exist, and rolls back", async () => {
  const { org, defaultCalendarId } = await setup();
  try {
    const response = await withOrgContext(org.orgId, () => POST(request({
      action: "save-calendar",
      id: defaultCalendarId,
      name: "Default",
      cadence: "monthly",
      yearStartMonth: 1,
    })));
    if (response.status !== 422) assert.fail(`expected 422, got ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /no active default fiscal calendar/);
    assert.match(body.error, /default flag/);
    assert.equal((await defaults(org.orgId)).length, 1, "the refused write must roll back, keeping the default");
  } finally {
    state.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});

test("save-calendar refuses to deactivate the default while periods exist", async () => {
  const { org, defaultCalendarId } = await setup();
  try {
    const response = await withOrgContext(org.orgId, () => POST(request({
      action: "save-calendar",
      id: defaultCalendarId,
      name: "Default",
      cadence: "monthly",
      yearStartMonth: 1,
      isActive: false,
    })));
    if (response.status !== 422) assert.fail(`expected 422, got ${response.status}: ${await response.text()}`);
    assert.match(((await response.json()) as { error: string }).error, /no active default fiscal calendar/);
    const rows = await withBypassContext(() => db.execute<{ is_active: boolean; is_default: boolean }>(sql`
      select is_active, is_default from fiscal_calendars where id = ${defaultCalendarId}`));
    assert.deepEqual(rows.rows[0], { is_active: true, is_default: true });
  } finally {
    state.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});

test("switching the default is a single atomic swap", async () => {
  const { org, defaultCalendarId } = await setup();
  try {
    const created = await withOrgContext(org.orgId, () => POST(request({
      action: "save-calendar",
      name: "Second",
      cadence: "monthly",
      yearStartMonth: 1,
    })));
    if (created.status !== 200) assert.fail(`expected 200, got ${created.status}: ${await created.text()}`);
    const secondId = ((await created.json()) as { id: string }).id;

    const swapped = await withOrgContext(org.orgId, () => POST(request({
      action: "save-calendar",
      id: secondId,
      name: "Second",
      cadence: "monthly",
      yearStartMonth: 1,
      isDefault: true,
    })));
    if (swapped.status !== 200) assert.fail(`expected 200, got ${swapped.status}: ${await swapped.text()}`);

    const rows = await defaults(org.orgId);
    assert.equal(rows.length, 1, "exactly one default survives the swap");
    assert.equal(rows[0]!.id, secondId);
    const old = await withBypassContext(() => db.execute<{ is_default: boolean }>(sql`
      select is_default from fiscal_calendars where id = ${defaultCalendarId}`));
    assert.equal(old.rows[0]?.is_default, false);
  } finally {
    state.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});

test("generate-periods refuses while the org has no active default, minting nothing", async () => {
  const { org, defaultCalendarId } = await setup();
  try {
    await withBypassContext(() => db.execute(sql`
      update fiscal_calendars set is_default = false where id = ${defaultCalendarId}`));
    const response = await withOrgContext(org.orgId, () => POST(request({
      action: "generate-periods",
      calendarId: defaultCalendarId,
      fiscalYear: 2031,
    })));
    if (response.status !== 422) assert.fail(`expected 422, got ${response.status}: ${await response.text()}`);
    assert.match(((await response.json()) as { error: string }).error, /no active default fiscal calendar/);
    const minted = await withBypassContext(() => db.execute<{ count: number }>(sql`
      select count(*)::int as count from accounting_periods where org_id = ${org.orgId} and fiscal_year = 2031`));
    assert.equal(minted.rows[0]?.count, 0, "the refused generation must mint no periods");
  } finally {
    state.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});
