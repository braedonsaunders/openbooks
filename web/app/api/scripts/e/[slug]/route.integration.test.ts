import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { SessionUser } from "../../../../../lib/auth";

const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __scriptEndpointHunt: session });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "./auth" && (context.parentURL ?? "").endsWith("/lib/authz.ts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function currentUser(){return globalThis.__scriptEndpointHunt.user}",
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
const { GET, POST } = await import("./route.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;
const SLUG = "shared-restlet";

function caller(orgId: string, userId: string): SessionUser {
  return {
    id: userId,
    email: `u-${userId.slice(0, 8)}@scratch.test`,
    name: "Endpoint caller",
    roles: [{ key: "script_exec", name: "script exec" }],
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

async function seedEndpoint(orgId: string, token: string): Promise<void> {
  await db.execute(sql`
    insert into user_scripts (org_id, name, trigger_point, endpoint_slug, source, is_active)
    values (
      ${orgId},
      ${"endpoint-" + token},
      'endpoint',
      ${SLUG},
      ${`function main(ctx) { return { token: ${JSON.stringify(token)} }; }`},
      true
    )`);
}

async function runCount(orgId: string): Promise<number> {
  return Number(
    (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from script_runs where org_id = ${orgId}
    `)).rows[0]!.n,
  );
}

function postReq(slug = SLUG): Request {
  return new Request(`http://audit.local/api/scripts/e/${slug}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

const params = { params: Promise.resolve({ slug: SLUG }) };

test("GET /api/scripts/e/[slug] must refuse before handle, auth, or runEndpointScript", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const getStart = source.indexOf("export async function GET");
  assert.ok(getStart >= 0, "GET export must remain so Next.js maps HEAD onto the refusal");
  const afterGet = source.slice(getStart + 1);
  const nextExport = afterGet.search(/export async function /);
  const getFn = source.slice(getStart, getStart + 1 + (nextExport === -1 ? afterGet.length : nextExport));
  assert.doesNotMatch(getFn, /\bhandle\s*\(/, "GET must not call handle()");
  assert.doesNotMatch(getFn, /\brunEndpointScript\b/, "GET must not execute the restlet");
  assert.doesNotMatch(getFn, /\bguardFeaturePermission\b/, "GET must not authenticate");
  assert.match(getFn, /\brefuseNonPost\s*\(/);

  const refusal = source.match(/function refuseNonPost\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(refusal, "missing refuseNonPost()");
  assert.match(refusal[0], /status:\s*405/);
  assert.match(refusal[0], /ENDPOINT_POST_ONLY/);
  assert.match(source, /only POST executes/);

  const handleFn = source.slice(source.indexOf("async function handle("), getStart);
  const postGate = handleFn.search(/req\.method\s*!==\s*['"]POST['"]/);
  const auth = handleFn.indexOf("guardFeaturePermission");
  const run = handleFn.indexOf("runEndpointScript");
  assert.ok(postGate >= 0, "handle() must gate on POST");
  assert.ok(postGate < auth && postGate < run, "POST gate must precede auth and script execution");
});

test("an unauthenticated caller cannot invoke an endpoint script", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableScripts(org.orgId);
    await seedEndpoint(org.orgId, "home");
    session.user = null;
    const getRes = await GET();
    assert.equal(getRes.status, 405, "GET must refuse before the session gate");
    assert.match((await getRes.json()).error, /only POST executes/);
    const postRes = await POST(postReq(), params);
    assert.equal(postRes.status, 401, "POST must refuse the unsigned caller");
    assert.deepEqual(await postRes.json(), { error: "unauthorized" });
    assert.equal(await runCount(org.orgId), 0, "no restlet run is recorded without a session");
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("authenticated GET /api/scripts/e/[slug] is 405, names that only POST executes, and inserts no script_runs", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableScripts(org.orgId);
    await seedEndpoint(org.orgId, "home");
    const userId = await createScratchUser(org.orgId, "Endpoint caller", "script_exec");
    await grant(org.orgId, "script_exec", ["scripts.execute"]);
    session.user = caller(org.orgId, userId);

    const getRes = await GET();
    assert.equal(getRes.status, 405);
    const getBody = await getRes.json() as { error: string };
    assert.match(getBody.error, /only POST executes/);
    assert.match(getBody.error, /POST \/api\/scripts\/e\//);
    assert.equal(await runCount(org.orgId), 0, "GET must not write script_runs");

    const postRes = await POST(postReq(), params);
    assert.equal(postRes.status, 200, "POST must still execute the restlet");
    assert.deepEqual(await postRes.json(), { ok: true, result: { token: "home" } });
    assert.equal(await runCount(org.orgId), 1, "only POST writes script_runs");
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("scripts.manage without scripts.execute cannot invoke a restlet", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableScripts(org.orgId);
    await seedEndpoint(org.orgId, "managed");
    const userId = await createScratchUser(org.orgId, "Script manager", "script_mgr");
    await grant(org.orgId, "script_mgr", ["scripts.manage"]);
    session.user = caller(org.orgId, userId);
    const res = await POST(postReq(), params);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /scripts\.execute/);
    assert.equal(await runCount(org.orgId), 0);
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("the same slug in another org is not invoked", { skip: !DB }, async () => {
  const home = await createScratchOrg();
  const other = await createScratchOrg();
  try {
    await enableScripts(home.orgId);
    await enableScripts(other.orgId);
    await seedEndpoint(home.orgId, "home");
    await seedEndpoint(other.orgId, "other");
    const userId = await createScratchUser(home.orgId, "Endpoint caller", "script_exec");
    await grant(home.orgId, "script_exec", ["scripts.execute"]);
    session.user = caller(home.orgId, userId);
    const res = await POST(postReq(), params);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, result: { token: "home" } });
    assert.equal(await runCount(home.orgId), 1);
    assert.equal(await runCount(other.orgId), 0, "foreign org restlet must not run");
  } finally {
    session.user = null;
    await dropScratchOrg(home.orgId);
    await dropScratchOrg(other.orgId);
  }
});
