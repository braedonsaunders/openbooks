import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "@openbooks/engine/src/testing/fixtures.ts";
import { upsertAssignment } from "@openbooks/engine/src/resourcing/assignments.ts";
import { defaultListView } from "@openbooks/customization";
import { allowedSubsidiaryIds } from "../subsidiaries.ts";
import { readEntityListPage, readResolvedEntityListPageForView } from "./entity-reader.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
const WEEKS = ["2026-10-04", "2026-10-11", "2026-10-18"];

async function seed(orgId: string, owner: string): Promise<void> {
  const employee = randomUUID(), project = randomUUID(), second = randomUUID();
  await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values (${employee}, ${orgId}, 'person', 'Reader', (select id from subsidiaries where org_id = ${orgId} limit 1), true, '{}'::jsonb)`);
  await db.execute(sql`insert into employee_roles (org_id, party_id, job_title, hired_on, is_active) values (${orgId}, ${employee}, 'Consultant', '2026-01-01', true)`);
  await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom) values (${project}, ${orgId}, (select id from subsidiaries where org_id = ${orgId} limit 1), 'RD', 'Reader project', null, 'active', true, '{}'::jsonb)`);
  for (const weekStart of WEEKS) {
    await upsertAssignment({ orgId, actorId: owner, allowedSubsidiaryIds: null, projectId: project, employeePartyId: employee, weekStart, plannedHours: "8.0000" });
  }
  await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values (${second}, ${orgId}, 'person', 'Reader two', (select id from subsidiaries where org_id = ${orgId} limit 1), true, '{}'::jsonb)`);
  await db.execute(sql`insert into employee_roles (org_id, party_id, job_title, hired_on, is_active) values (${orgId}, ${second}, 'Consultant', '2026-01-01', true)`);
  await upsertAssignment({ orgId, actorId: owner, allowedSubsidiaryIds: null, projectId: project, employeePartyId: second, weekStart: "2026-10-11", plannedHours: "4.0000" });
}

async function orgWith(featured: boolean) {
  const org = await withBypassContext(() => createScratchOrg());
  const owner = await withBypassContext(() => createScratchUser(org.orgId, "Reader owner", "reader-owner"));
  await withBypassContext(async () => {
    if (featured) assert.equal((await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"projects":true,"resourcing":true}'::jsonb) where id = ${org.orgId} returning id`)).rows.length, 1, "entity reader fixture feature setup updates one organization");
    assert.equal((await db.execute(sql`update app_roles set permissions = '["resourcing.read","projects.read"]' where org_id = ${org.orgId} and key = 'reader-owner' returning key`)).rows.length, 1, "entity reader fixture permission setup updates reader-owner role");
    if (featured) await seed(org.orgId, owner);
  });
  return { org, owner };
}

async function scopedActor(orgId: string, name: string, key: string, restriction: unknown, perms = '["resourcing.read"]') {
  return withBypassContext(async () => {
    const actor = await createScratchUser(orgId, name, key);
    assert.equal((await db.execute(sql`update app_roles set permissions = ${perms}::jsonb, subsidiary_restriction = ${JSON.stringify(restriction)}::jsonb where org_id = ${orgId} and key = ${key} returning key`)).rows.length, 1, `${key}: entity reader scoped actor setup updates one role`);
    return actor;
  });
}

const trusted = (orgId: string, over: Record<string, unknown> = {}, accepted?: ReadonlyMap<string, readonly string[]>) => readResolvedEntityListPageForView({
  recordType: "resourcing_assignment", orgId, allowedSubsidiaryIds: null, view: defaultListView("resourcing_assignment"),
  sort: "week", dir: "asc", page: 1, perPage: 25, ...over,
}, { inventory: true, crm: false, hrm: false }, undefined, accepted);

const query = (orgId: string, actor: string, over: Record<string, unknown> = {}) => ({
  recordType: "resourcing_assignment", orgId, actorId: actor, allowedSubsidiaryIds: null, ...over,
}) as Parameters<typeof readEntityListPage>[0];

test("refusal matrix fires every named refusal with a usable remedy", enabled, async () => {
  const { org, owner } = await orgWith(true);
  try {
    const sub = (await withBypassContext(() => db.execute<{ id: string }>(sql`select id from subsidiaries where org_id = ${org.orgId} limit 1`))).rows[0]!.id;
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["record", { recordType: "nope" }, /unknown_record_type/],
      ["scope-missing", { allowedSubsidiaryIds: undefined }, /missing_scope/],
      ["scope-array", { allowedSubsidiaryIds: [sub] }, /invalid_scope/],
      ["scope-object", { allowedSubsidiaryIds: {} }, /invalid_scope/],
      ["prop", { bogus: 1 }, /unknown_property/],
      ["actor", { actorId: randomUUID() }, /actor_unresolvable/],
      ["scope-stale", { allowedSubsidiaryIds: new Set([randomUUID()]) }, /stale_scope/],
      ["sort", { sort: "nope" }, /unknown_sort/],
      ["dir", { sort: "week", dir: "sideways" }, /invalid_dir/],
      ["page", { page: 1.5 }, /invalid_page/],
      ["perPage", { perPage: 2.5 }, /invalid_per_page/],
      ["filter", { filters: [{ key: "nope", operator: "eq", value: "x" }] }, /invalid_view/],
      ["cf-stale", { filters: [{ key: "cf_gone", operator: "eq", value: "x" }] }, /invalid_view/],
      ["uuid", { filters: [{ key: "project_id", operator: "eq", value: "not-a-uuid" }] }, /invalid_filter_value/],
    ];
    for (const [name, over, want] of cases) {
      const r = await readEntityListPage(query(org.orgId, owner, over));
      assert.ok(!r.ok && want.test(r.error) && r.remedy.length > 10 && r.error !== "feature_state_unavailable", `${name}: ${JSON.stringify(r)}`);
      if (name === 'filter' && !r.ok) assert.match(r.remedy, /unknown filter "nope"/);
    }
    const mismatch = await trusted(org.orgId, { view: { ...defaultListView("resourcing_assignment"), recordType: "retainer" } });
    assert.ok(!mismatch.ok && /view_record_type_mismatch/.test(mismatch.error));
  } finally { await dropScratchOrgReporting(org.orgId); }
});

test("null, empty, and many scopes deliver at runtime", enabled, async () => {
  const { org, owner } = await orgWith(true);
  try {
    const sub = (await withBypassContext(() => db.execute<{ id: string }>(sql`select id from subsidiaries where org_id = ${org.orgId} limit 1`))).rows[0]!.id;
    const all = await readEntityListPage(query(org.orgId, owner));
    assert.ok(all.ok && all.filteredTotal === 4, "null scope reads all rows");
    const emptyActor = await scopedActor(org.orgId, "Empty", "reader-empty", { mode: "list", subsidiaryIds: [] });
    const none = await readEntityListPage(query(org.orgId, emptyActor, { allowedSubsidiaryIds: new Set<string>() }));
    assert.ok(none.ok && none.filteredTotal === 0 && none.rows.length === 0, "empty scope reads nothing");
    const granted = new Set([sub, randomUUID()]);
    const manyActor = await scopedActor(org.orgId, "Many", "reader-many", { mode: "list", subsidiaryIds: [...granted] });
    const fresh = await allowedSubsidiaryIds(manyActor, org.orgId);
    const many = await readEntityListPage(query(org.orgId, manyActor, { allowedSubsidiaryIds: fresh }));
    assert.ok(many.ok, "exact fresh many-set executes");
    const noperm = await scopedActor(org.orgId, "NoPerm", "reader-noperm", null, '[]');
    const denied = await readEntityListPage(query(org.orgId, noperm));
    assert.ok(!denied.ok && /forbidden/.test(denied.error), "grantless actor compiles nothing");
    const deniedSort = await readEntityListPage(query(org.orgId, noperm, { sort: "nope" }));
    assert.ok(!deniedSort.ok && /forbidden/.test(deniedSort.error), "permission refuses before sort compiles");
  } finally { await dropScratchOrgReporting(org.orgId); }
});

test("direct and trusted wrappers agree on ids, total, and order", enabled, async () => {
  const { org, owner } = await orgWith(true);
  try {
    const args = query(org.orgId, owner, { sort: "week", dir: "asc", perPage: 25 });
    const direct = await readEntityListPage(args);
    const via = await trusted(org.orgId);
    assert.ok(direct.ok && via.ok);
    if (direct.ok && via.ok) {
      assert.deepEqual([direct.rows.map((r) => r.id), direct.filteredTotal], [via.rows.map((r) => r.id), via.filteredTotal]);
    }
    const badQuick = await trusted(org.orgId, { adhoc: { filters: { nope: "x" } } });
    assert.ok(!badQuick.ok && /unknown_filter/.test(badQuick.error));
    const badVal = await trusted(org.orgId, { adhoc: { filters: { state: "nope" } } });
    assert.ok(!badVal.ok && /invalid_filter_value/.test(badVal.error));
    const emptyAccepted = await trusted(org.orgId, { adhoc: { filters: { state: "active" } } }, new Map([["state", []]]));
    assert.ok(!emptyAccepted.ok && /invalid_filter_value/.test(emptyAccepted.error), "empty accepted set rejects every value");
    const namedAccepted = await trusted(org.orgId, { adhoc: { filters: { state: "active" } } }, new Map([["state", ["active"]]]));
    assert.ok(namedAccepted.ok, "passed accepted sets execute without reloading");
  } finally { await dropScratchOrgReporting(org.orgId); }
});

test("tied rows order deterministically; out-of-range page is empty with positive total", enabled, async () => {
  const { org, owner } = await orgWith(true);
  try {
    const page = (p: number) => readEntityListPage(query(org.orgId, owner, { sort: "week", dir: "asc", perPage: 5, page: p }));
    const a = await page(1), b = await page(1), c = await page(2), far = await page(9999);
    assert.ok(a.ok && b.ok && c.ok && far.ok);
    if (a.ok && b.ok && c.ok && far.ok) {
      assert.deepEqual(a.rows.map((r) => r.id), b.rows.map((r) => r.id));
      assert.equal(a.rows.filter((r) => String(r.week_start).startsWith("2026-10-11")).length, 2, "one week carries the real tie");
      assert.equal(new Set([...a.rows, ...c.rows].map((r) => r.id)).size, 4);
      assert.deepEqual(far.rows, []);
      assert.ok(far.filteredTotal === 4);
    }
  } finally { await dropScratchOrgReporting(org.orgId); }
});

test("feature-off refuses by name; outage rejects instead of refusing", enabled, async () => {
  const { org, owner } = await orgWith(false);
  try {
    const r = await readEntityListPage(query(org.orgId, owner));
    assert.ok(!r.ok && /feature_disabled/.test(r.error) && /Features/.test(r.remedy));
    await assert.rejects(withOrgTransaction(org.orgId, async () => {
      // A real PostgreSQL transaction failure makes the next storage read
      // unavailable; malformed JSON configuration is not a storage outage.
      await assert.rejects(db.execute(sql`select 1 / 0`));
      return readEntityListPage(query(org.orgId, owner));
    }), (error) => {
      assert.ok(error instanceof Error);
      const cause = error.cause instanceof Error ? error.cause : error;
      assert.match(cause.message, /current transaction is aborted/);
      return true;
    });
  } finally { await dropScratchOrgReporting(org.orgId); }
});

test("project enrichment lands on returned rows only", enabled, async () => {
  const { org, owner } = await orgWith(true);
  try {
    const r = await readEntityListPage({ ...query(org.orgId, owner), recordType: "project", perPage: 1 });
    assert.ok(r.ok && r.rows.length === 1 && "actual" in r.rows[0]!);
  } finally { await dropScratchOrgReporting(org.orgId); }
});
