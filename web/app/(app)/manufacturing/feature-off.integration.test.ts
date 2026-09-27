import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { db, env, withBypassContext } from "@openbooks/engine/src/platform/db.ts";
import { ManufacturingFeatureDisabledError } from "@openbooks/engine/src/manufacturing/errors.ts";
import { manufacturingFeatureEnabled } from "@openbooks/engine/src/manufacturing/gate.ts";
import { postManufacturingEntry } from "@openbooks/engine/src/manufacturing/journal.ts";
import { featureGateLockKey } from "@openbooks/engine/src/organization/org-feature-lock.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";
import { waitForLockWaiter } from "@openbooks/engine/src/testing/lock-wait.ts";
import { JOURNAL_ENTRY_TABLE } from "@/lib/customization/entity-list-query/journal-entries";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const evidence = { workOrderNumber: "WO-200", bomRevision: "BOM-1", routingVersion: "RT-1" };
const routeState: { gate: { user: { id: string; orgId: string }; permissions: Set<string>; allowedSubsidiaryIds: null } | null } = { gate: null };
Object.assign(globalThis, { __manufacturingFeatureOff: routeState });
const authzStub = `export async function guardPermission(){return globalThis.__manufacturingFeatureOff.gate}
export async function requirePermission(){return globalThis.__manufacturingFeatureOff.gate}
export function guardSubsidiaryScope(){return null}
export async function guardRootSubsidiaryScope(){return false}
export function guardUnrestrictedScope(){return null}
export async function getAuthz(){return globalThis.__manufacturingFeatureOff.gate}`;
registerHooks({ resolve(specifier, context, next) {
  const parent = context.parentURL ?? "";
  const routeCaller = ["/api/admin/setup/", "/api/manufacturing/", "/lib/api/route.ts", "/lib/feature-gates.ts", "/admin/setup/manufacturing/view.ts"]
    .some((path) => parent.includes(path));
  if (routeCaller && (specifier.endsWith("/lib/authz") || (parent.includes("/lib/feature-gates.ts") && specifier === "./authz"))) {
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(authzStub)}` };
  }
  return next(specifier, context);
} });
const { POST: setupPost } = await import("../../api/admin/setup/[entity]/route");
const { POST: manufacturingPost } = await import("../../api/manufacturing/work-centers/route");
const { loadManufacturingSetup } = await import("../admin/setup/manufacturing/view");

async function features(orgId: string, state: Record<string, boolean>) {
  await withBypassContext(async () => assert.equal((await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||${JSON.stringify(state)}::jsonb) where id=${orgId} returning id`)).rows.length, 1));
}
function postingInput(org: ScratchOrg, actorId: string, currency: string) { return { orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId, actorId, currency, periodId: org.periodId, date: org.date, entryNumber: `MFG-${randomUUID()}`, memo: "Production cost", lines: [{ accountId: org.accounts.invAsset, amount: "10.00" }, { accountId: org.accounts.cogs, amount: "-10.00" }], custom: evidence }; }
async function post(org: ScratchOrg, actorId: string) { return withBypassContext(() => db.transaction((tx) => postManufacturingEntry(tx, postingInput(org, actorId, "CAD")))); }
async function snapshot(orgId: string, id: string) { return withBypassContext(async () => ({ entry: (await db.execute(sql`select * from journal_entries where org_id=${orgId} and id=${id}`)).rows[0], lines: (await db.execute(sql`select * from journal_lines where org_id=${orgId} and entry_id=${id} order by line_number`)).rows })); }
async function listed(orgId: string, id: string) { return withBypassContext(async () => (await db.execute(sql`select e.id from ${sql.raw(JOURNAL_ENTRY_TABLE)} e where e.org_id=${orgId} and e.id=${id}`)).rows.map((row) => row.id)); }
async function refuses(posting: Promise<unknown>) { await assert.rejects(posting, (error: unknown) => error instanceof ManufacturingFeatureDisabledError && /manufacturing/i.test(error.message) && error.message.includes("Turn it on in Company Settings → Features")); }
function setupWrite(entity: string, body: Record<string, unknown>) {
  return setupPost(new Request(`http://audit.local/api/admin/setup/${entity}`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ entity }) });
}
function manufacturingWrite(_orgId: string) {
  return manufacturingPost(new Request("http://audit.local/api/manufacturing/work-centers", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
  }), { params: Promise.resolve({}) });
}

test("manufacturing is off by default, parent-fenced, and preserves posted history", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Shop lead", "admin")); assert.equal(await withBypassContext(() => manufacturingFeatureEnabled(org.orgId, "manufacturing")), false); await refuses(post(org, actorId));
    await features(org.orgId, { manufacturing: true, inventory: false });
    assert.equal(await withBypassContext(() => manufacturingFeatureEnabled(org.orgId, "manufacturing")), false);
    await refuses(post(org, actorId));
    const refusedCount = await withBypassContext(async () => (await db.execute(sql`select count(*)::int as n from journal_entries where org_id=${org.orgId} and origin='manufacturing'`)).rows[0]!.n);
    assert.equal(refusedCount, 0);
    await features(org.orgId, { manufacturing: true, inventory: true });
    routeState.gate = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(["admin.setup.manage"]), allowedSubsidiaryIds: null };
    const scrap = await setupWrite("mfg-scrap-reasons", { code: "NORMAL", name: "Normal trim loss", classification: "normal", isActive: true });
    assert.equal(scrap.status, 200, await scrap.clone().text());
    const scrapId = String((await scrap.json()).id);
    const first = await post(org, actorId); const original = await snapshot(org.orgId, first);
    assert.deepEqual(await listed(org.orgId, first), [first]);
    await features(org.orgId, { manufacturing: false });
    await refuses(post(org, actorId));
    const fencedSetup = await setupWrite("mfg-scrap-reasons", { code: "OFF", name: "Unavailable reason", classification: "normal", isActive: true });
    assert.equal(fencedSetup.status, 404);
    const fencedManufacturing = await manufacturingWrite(org.orgId);
    const unavailable = await fencedManufacturing.json();
    assert.equal(fencedManufacturing.status, 404);
    assert.doesNotMatch(JSON.stringify(unavailable), /manufacturing/i);
    await assert.rejects(loadManufacturingSetup(), (error: unknown) => error instanceof Error && /NEXT_REDIRECT/.test(error.message));
    const preservedScrap = await withBypassContext(async () => db.execute(sql`select id from mfg_scrap_reasons where org_id=${org.orgId} and id=${scrapId}`));
    assert.equal(preservedScrap.rows.length, 1);
    assert.deepEqual(await snapshot(org.orgId, first), original);
    assert.deepEqual(await listed(org.orgId, first), [first]);
    await features(org.orgId, { manufacturing: true });
    assert.deepEqual(await snapshot(org.orgId, first), original);
    assert.equal((await setupWrite("mfg-scrap-reasons", { code: "RETURNED", name: "Available after re-enable", classification: "normal", isActive: true })).status, 200);
    const second = await post(org, actorId);
    assert.notEqual(second, first);
    assert.deepEqual(await listed(org.orgId, second), [second]);
  } finally { await dropScratchOrg(org.orgId); }
});

const postingDisableOrderings = [{ ordering: "poster-first", expectedEntries: 1 }, { ordering: "disable-first", expectedEntries: 0 }] as const;
async function disableOn(writer: pg.Client, orgId: string) {
  await writer.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [featureGateLockKey(orgId)]);
  assert.equal((await writer.query("select id from orgs where id=$1 for update", [orgId])).rowCount, 1);
  assert.equal((await writer.query(`update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',coalesce(settings->'features','{}'::jsonb)||'{"manufacturing":false}'::jsonb) where id=$1 returning id`, [orgId])).rowCount, 1);
}

test("manufacturing feature row lock orders posting against disable", { skip: !DB }, async () => { for (const { ordering, expectedEntries } of postingDisableOrderings) {
    const org = await withBypassContext(() => createScratchOrg()), admin = new pg.Client({ connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL ?? env.OPENBOOKS_DB_URL }), poster = new pg.Client({ connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL ?? env.OPENBOOKS_DB_URL });
    let pendingPost: Promise<string> | undefined, pendingDisable: Promise<void> | undefined;
    try {
      const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Shop lead", "admin")); const currency = await withBypassContext(async () => (await db.execute<{ base_currency: string }>(sql`select base_currency from orgs where id=${org.orgId}`)).rows[0]!.base_currency);
      const input = postingInput(org, actorId, currency); await features(org.orgId, { manufacturing: true, inventory: true }); await admin.connect(); await poster.connect();
      const posterDb = drizzle({ client: poster });
      if (ordering === "poster-first") {
        await poster.query("begin"); const firstEntry = await postManufacturingEntry(posterDb, input); await admin.query("begin");
        pendingDisable = disableOn(admin, org.orgId); void pendingDisable.catch(() => undefined);
        await waitForLockWaiter(poster, { label: "the manufacturing feature disable" }); await poster.query("commit"); await pendingDisable; await admin.query("commit");
        assert.deepEqual((await withBypassContext(async () => db.execute(sql`select status from journal_entries where org_id=${org.orgId} and id=${firstEntry}`))).rows, [{ status: "posted" }]);
        await refuses(withBypassContext(() => db.transaction((tx) => postManufacturingEntry(tx, input))));
      } else {
        await admin.query("begin"); await disableOn(admin, org.orgId); await poster.query("begin");
        pendingPost = postManufacturingEntry(posterDb, input); void pendingPost.catch(() => undefined);
        await waitForLockWaiter(admin, { label: "the manufacturing post" }); await admin.query("commit"); await refuses(pendingPost!); await poster.query("rollback");
      }
      assert.equal(await withBypassContext(async () => (await db.execute<{ n: number }>(sql`select count(*)::int as n from journal_entries where org_id=${org.orgId} and origin='manufacturing'`)).rows[0]!.n), expectedEntries);
    } finally {
      const first = ordering === "poster-first" ? poster : admin, second = ordering === "poster-first" ? admin : poster;
      await first.query("rollback").catch(() => undefined); await second.query("rollback").catch(() => undefined);
      await Promise.allSettled([pendingPost, pendingDisable].filter((pending): pending is NonNullable<typeof pending> => pending !== undefined));
      await poster.end().catch(() => undefined); await admin.end().catch(() => undefined); await dropScratchOrg(org.orgId);
    }
  }
});
