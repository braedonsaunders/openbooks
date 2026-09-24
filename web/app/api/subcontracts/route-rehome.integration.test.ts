import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { Pool } from "pg";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { SessionUser } from "../../../lib/auth";

const root = pathToFileURL(process.cwd() + "/").href;
const engineRoot = new URL("../../../../engine/", import.meta.url).href;
const state: { user: SessionUser | null; allowedSubsidiaryId: string | null } = { user: null, allowedSubsidiaryId: null };
Object.assign(globalThis, { __subcontractRehomeRace: state });
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "../../../lib/authz" && context.parentURL?.endsWith("/api/subcontracts/route.ts")) {
    return { shortCircuit: true, url: "mock:subcontract-rehome-authz" };
  }
  if (specifier === "../../../lib/subcontracts-gate" && context.parentURL?.endsWith("/api/subcontracts/route.ts")) {
    return { shortCircuit: true, url: "mock:subcontract-rehome-gate" };
  }
  if (specifier.startsWith("@openbooks/engine/")) {
    return nextResolve(new URL(specifier.slice("@openbooks/engine/".length), engineRoot).href, context);
  }
  if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
    return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__subcontractRehomeRace.user}" };
  }
  if (specifier.startsWith("@/")) {
    const path = root + "web/" + specifier.slice(2);
    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      if (existsSync(new URL(path + suffix))) return nextResolve(path + suffix, context);
    }
    return nextResolve(path, context);
  }
  return nextResolve(specifier, context);
}, load(url, context, nextLoad) {
  if (url === "mock:subcontract-rehome-authz") return { format: "module", shortCircuit: true, source: `
    const state = globalThis.__subcontractRehomeRace;
    export async function guardPermission() { return { user: state.user, allowedSubsidiaryIds: new Set([state.allowedSubsidiaryId]) }; }
    export function guardSubsidiaryScope(authz, subsidiaryId) { return authz.allowedSubsidiaryIds.has(subsidiaryId) ? null : new Response(JSON.stringify({error:'not found'}), {status:404}); }
  ` };
  if (url === "mock:subcontract-rehome-gate") return { format: "module", shortCircuit: true, source: "export async function guardSubcontractsFeature() { return null }" };
  return nextLoad(url, context);
} });

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { createSubcontract } = await import("@openbooks/engine/src/projects/subcontracts.ts");
const { GET, POST } = await import("./route.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

function session(orgId: string, actorId: string): SessionUser {
  return { id: actorId, orgId, name: "Subcontract clerk", email: "clerk@scratch.test", roles: [], isSuperAdmin: false,
    envKind: "production", productionOrgId: orgId, homeOrgId: orgId, homeUserId: actorId };
}

test("POST rechecks the project scope after waiting out a concurrent rehome", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const holder = await new Pool({ connectionString: process.env.OPENBOOKS_DB_URL }).connect();
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Subcontract clerk", "subcontract_clerk"));
    await withBypassContext(() => db.execute(sql`
      update app_roles set permissions = '["ap.create","ap.read"]'::jsonb,
        subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
       where org_id = ${org.orgId} and key = 'subcontract_clerk'
    `));
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features','{}'::jsonb) || '{"projects":true,"subcontracts":true}'::jsonb)
       where id = ${org.orgId}
    `));
    const subsidiaryB = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${subsidiaryB}, ${org.orgId}, ${org.subsidiaryId}, 'Other Entity', 'CAD', 'CA')
    `));
    const projectId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
      insert into projects (org_id, subsidiary_id, code, name, status, is_active, custom)
      values (${org.orgId}, ${org.subsidiaryId}, 'SC-RACE', 'Scope race project', 'active', true, '{}'::jsonb)
      returning id
    `))).rows[0]!.id;
    const vendorId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
      insert into parties (org_id, kind, display_name, is_active)
      values (${org.orgId}, 'company', 'Scope race vendor', true) returning id
    `))).rows[0]!.id;
    await withBypassContext(() => db.execute(sql`
      insert into vendor_roles (org_id, party_id, is_active) values (${org.orgId}, ${vendorId}, true)
    `));
    const subcontractId = (await withBypassContext(() => createSubcontract({
      orgId: org.orgId, userId: actorId, projectId, vendorId, number: "SC-RACE-1", title: "Before race", originalCommitment: "100.00",
    }))).id;
    state.user = session(org.orgId, actorId);
    state.allowedSubsidiaryId = org.subsidiaryId;
    await holder.query("begin");
    await holder.query("select set_config('app.bypass_rls', 'on', true)");
    const locked = await holder.query("select id from projects where id = $1 for update", [projectId]);
    assert.equal(locked.rows.length, 1);
    let settled = false;
    const pending = withOrgContext(org.orgId, () => POST(new Request("http://openbooks.test/api/subcontracts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "updateSubcontract", id: subcontractId, title: "After race", originalCommitment: "100.00", defaultRetainagePercent: "10" }),
    }))).then((response) => { settled = true; return response; });
    let waiting = 0;
    const deadline = Date.now() + 10_000;
    while (waiting === 0 && Date.now() < deadline) {
      waiting = (await holder.query(`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'`)).rows[0].n as number;
      if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(settled, false, "POST must wait on the locked project row");
    assert.ok(waiting > 0, "POST is blocked behind the project lock");
    await holder.query("update projects set subsidiary_id = $1 where id = $2", [subsidiaryB, projectId]);
    await holder.query("commit");
    const response = await pending;
    assert.equal(response.status, 404, JSON.stringify(await response.clone().json()));
    assert.deepEqual(await response.json(), { error: "not found" });
    const result = (await withBypassContext(() => db.execute(sql`
      select s.title, p.subsidiary_id from subcontracts s join projects p on p.id = s.project_id and p.org_id = s.org_id
       where s.org_id = ${org.orgId} and s.id = ${subcontractId}
    `))).rows[0] as { title: string; subsidiary_id: string };
    assert.deepEqual(result, { title: "Before race", subsidiary_id: subsidiaryB });
  } finally {
    await holder.query("rollback").catch(() => undefined);
    holder.release();
    state.user = null;
    state.allowedSubsidiaryId = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("GET detail retries a stale snapshot after a project is rehomed", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const holder = await new Pool({ connectionString: process.env.OPENBOOKS_DB_URL }).connect();
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Subcontract clerk", "subcontract_clerk"));
    await withBypassContext(() => db.execute(sql`
      update app_roles set permissions = '["ap.create","ap.read"]'::jsonb,
        subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
       where org_id = ${org.orgId} and key = 'subcontract_clerk'
    `));
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features','{}'::jsonb) || '{"projects":true,"subcontracts":true}'::jsonb)
       where id = ${org.orgId}
    `));
    const subsidiaryB = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${subsidiaryB}, ${org.orgId}, ${org.subsidiaryId}, 'Other Entity', 'CAD', 'CA')
    `));
    const projectId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
      insert into projects (org_id, subsidiary_id, code, name, status, is_active, custom)
      values (${org.orgId}, ${org.subsidiaryId}, 'SC-GET-RACE', 'Scope read project', 'active', true, '{}'::jsonb)
      returning id
    `))).rows[0]!.id;
    const vendorId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
      insert into parties (org_id, kind, display_name, is_active)
      values (${org.orgId}, 'company', 'Scope read vendor', true) returning id
    `))).rows[0]!.id;
    await withBypassContext(() => db.execute(sql`
      insert into vendor_roles (org_id, party_id, is_active) values (${org.orgId}, ${vendorId}, true)
    `));
    const subcontractId = (await withBypassContext(() => createSubcontract({
      orgId: org.orgId, userId: actorId, projectId, vendorId, number: "SC-GET-RACE-1", title: "Read race", originalCommitment: "100.00",
    }))).id;
    state.user = session(org.orgId, actorId);
    state.allowedSubsidiaryId = org.subsidiaryId;
    await holder.query("begin");
    await holder.query("select set_config('app.bypass_rls', 'on', true)");
    await holder.query("select id from projects where id = $1 for update", [projectId]);
    let settledResponse: Response | undefined;
    const pending = withOrgContext(org.orgId, () => GET(new Request(
      `http://openbooks.test/api/subcontracts?id=${subcontractId}`,
    ))).then((response) => { settledResponse = response; return response; });
    let waiting = 0;
    const deadline = Date.now() + 10_000;
    while (waiting === 0 && Date.now() < deadline) {
      waiting = (await holder.query(`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'`)).rows[0].n as number;
      if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(settledResponse, undefined, `GET must wait on the locked project row, got ${settledResponse?.status}: ${JSON.stringify(await settledResponse?.clone().json().catch(() => null))}`);
    assert.ok(waiting > 0, "GET reached the locked project row");
    await holder.query("update projects set subsidiary_id = $1 where id = $2", [subsidiaryB, projectId]);
    await holder.query("commit");
    const response = await pending;
    assert.equal(response.status, 404, JSON.stringify(await response.clone().json()));
    assert.deepEqual(await response.json(), { error: "not found" });
  } finally {
    await holder.query("rollback").catch(() => undefined);
    holder.release();
    state.user = null;
    state.allowedSubsidiaryId = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
