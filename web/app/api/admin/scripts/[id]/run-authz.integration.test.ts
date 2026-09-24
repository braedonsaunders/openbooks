import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { SessionUser } from "../../../../../lib/auth";

const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __scriptAdminRunHunt: session });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "./auth" && (context.parentURL ?? "").endsWith("/lib/authz.ts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function currentUser(){return globalThis.__scriptAdminRunHunt.user}",
      };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { POST } = await import("./run/route.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

function caller(orgId: string, userId: string): SessionUser {
  return {
    id: userId,
    email: `u-${userId.slice(0, 8)}@scratch.test`,
    name: "Script administrator",
    roles: [{ key: "script_admin", name: "script admin" }],
    orgId,
    envKind: "production",
    productionOrgId: orgId,
    isSuperAdmin: false,
    homeUserId: userId,
    homeOrgId: orgId,
  };
}

async function enableScripts(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features,scripts}', 'true'::jsonb)
     where id = ${orgId}`);
}

async function grant(orgId: string, roleKey: string, permissions: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles set permissions = ${JSON.stringify(permissions)}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function seedScheduled(orgId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into user_scripts (id, org_id, name, trigger_point, source, cron, next_run_at, is_active)
    values (
      ${id}, ${orgId}, 'Nightly', 'scheduled',
      'function main(ctx) { return 1; }',
      '0 12 * * *', '2030-01-01 12:00:00+00', true
    )`);
  return id;
}

async function seedBulk(orgId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into user_scripts (id, org_id, name, trigger_point, source, is_active)
    values (${id}, ${orgId}, 'Manual', 'bulk', 'function main(ctx) { return 1; }', true)`);
  return id;
}

async function runCount(orgId: string): Promise<number> {
  return Number(
    (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from script_runs where org_id = ${orgId}
    `)).rows[0]!.n,
  );
}

function runReq(id: string, body?: unknown): Request {
  return new Request(`http://audit.local/api/admin/scripts/${id}/run`, {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

test("an unauthenticated caller cannot Run now", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableScripts(org.orgId);
    const id = await seedScheduled(org.orgId);
    session.user = null;
    const res = await POST(runReq(id), { params: Promise.resolve({ id }) });
    assert.equal(res.status, 401);
    assert.equal(await runCount(org.orgId), 0);
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("scripts.execute without scripts.manage cannot Run now", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableScripts(org.orgId);
    const id = await seedScheduled(org.orgId);
    const userId = await createScratchUser(org.orgId, "Restlet caller", "script_exec");
    await grant(org.orgId, "script_exec", ["scripts.execute"]);
    session.user = caller(org.orgId, userId);
    const res = await POST(runReq(id), { params: Promise.resolve({ id }) });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /scripts\.manage/);
    assert.equal(await runCount(org.orgId), 0);
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("Run now cannot execute another organization's script by id", { skip: !DB }, async () => {
  const home = await createScratchOrg();
  const other = await createScratchOrg();
  try {
    await enableScripts(home.orgId);
    await enableScripts(other.orgId);
    const foreignId = await seedScheduled(other.orgId);
    const userId = await createScratchUser(home.orgId, "Script administrator", "script_admin");
    await grant(home.orgId, "script_admin", ["scripts.manage"]);
    session.user = caller(home.orgId, userId);
    const res = await POST(runReq(foreignId), { params: Promise.resolve({ id: foreignId }) });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not found" });
    assert.equal(await runCount(other.orgId), 0, "foreign scheduled script must not run");
    assert.equal(await runCount(home.orgId), 0);
  } finally {
    session.user = null;
    await dropScratchOrg(home.orgId);
    await dropScratchOrg(other.orgId);
  }
});

test("bulk Run now refuses requests without a stable client idempotency key", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableScripts(org.orgId);
    const id = await seedBulk(org.orgId);
    const userId = await createScratchUser(org.orgId, "Script administrator", "script_admin");
    await grant(org.orgId, "script_admin", ["scripts.manage"]);
    session.user = caller(org.orgId, userId);
    const res = await POST(runReq(id), { params: Promise.resolve({ id }) });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "SCRIPT_RUN_KEY_INVALID");
    assert.equal(await runCount(org.orgId), 0, "a refused request must not create a script run");
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});
