import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, env, pool, withBypassContext, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import { resolveKeyScopeAuthority } from "@openbooks/engine/src/organization/permissions.ts";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";

/**
 * Regression coverage for the empty-scopes defect in the API-key contract:
 * POST defaulted an omitted scopes field to [] and resolveApiKeyAuth treated
 * an empty scope array as "inherit the owner's full effective permission
 * set", so a missing UI/API field minted a full financial-access credential.
 *
 * The seams here are the real ones production takes: the real
 * `/api/admin/api-keys` route handlers (only the session gate is seammed to a
 * fixture actor), the real `resolveApiKeyAuth`/`guardApiKey` pair against a
 * real database, and the real canonical `resolveKeyScopeAuthority` helper
 * both of them share.
 */

const DB = !!env.OPENBOOKS_DB_URL;

// ---------------------------------------------------------------------------
// Real route seam: the actual POST/PATCH handlers with only the session gate
// seammed to a fixture actor; DB, transactions, and audit evidence are real.
// ---------------------------------------------------------------------------

interface RouteActorState {
  orgId: string;
  userId: string;
}

const actorStateKey = Symbol.for("openbooks.api-key-scopes-test");
const actorState: RouteActorState = {
  orgId: randomUUID(),
  userId: randomUUID(),
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[actorStateKey] = actorState;

const featureGatesMock = `
  const state = globalThis[Symbol.for("openbooks.api-key-scopes-test")]
  export async function guardFeaturePermission() {
    // Fixture actors own every permission across all entities, so the F21
    // grant ceiling evaluates and passes here; the ceiling's own refusals
    // are covered by the api-keys route boundary suite.
    return {
      user: { orgId: state.orgId, id: state.userId, isSuperAdmin: false },
      permissions: new Set(['*']),
      allowedSubsidiaryIds: null,
    }
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // Web modules carry the server-only client guard; plain node runs stub it.
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (context.parentURL?.includes("api-keys/route.ts")) {
      // Only the session boundary is seammed; the JSON body boundary stays real.
      if (specifier === "../../../../lib/feature-gates") {
        return { url: "mock:feature-gates", shortCircuit: true };
      }
      if (specifier === "@/lib/api/json") {
        return { url: new URL("./api/json.ts", import.meta.url).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:feature-gates") {
      return { format: "module", source: featureGatesMock, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "../app/api/admin/api-keys/route.ts?api-key-scopes-test";
const { PATCH, POST } = (await import(routeUrl)) as typeof import("../app/api/admin/api-keys/route.ts");
// api-auth.ts is server-only too; it loads under the same stubbed boundary.
const { canApi, generateApiKey, guardApiKey, resolveApiKeyAuth } = await import("./api-auth");
const { validateSessionToken } = await import("./auth");
const { sessionSigningInput } = await import("./auth-token-format.ts");
hooks.deregister();

function jsonRequest(body: unknown, method: "POST" | "PATCH" = "POST"): Request {
  return new Request("http://openbooks.test/api/admin/api-keys", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Complete asynchronous setup before registering tests so --test-force-exit
// cannot finish the initial queue while later tests are still being loaded.
test("the canonical scope authority fails closed on empty, malformed, or non-catalogue declarations", () => {
  const owner = new Set(["gl.read", "ap.pay"]);
  assert.equal(resolveKeyScopeAuthority(owner, []), null, "empty scopes authenticate nothing");
  assert.equal(resolveKeyScopeAuthority(owner, null), null, "missing scopes authenticate nothing");
  assert.equal(resolveKeyScopeAuthority(owner, "gl.read"), null, "a non-array declaration authenticates nothing");
  assert.equal(resolveKeyScopeAuthority(owner, ["*"]), null, "a direct-write wildcard is inert");
  assert.equal(resolveKeyScopeAuthority(owner, ["not.a.permission"]), null, "non-catalogue scopes grant nothing");
  assert.deepEqual(
    resolveKeyScopeAuthority(owner, ["gl.read", "not.a.permission"]),
    new Set(["gl.read"]),
    "junk entries are dropped, valid ones kept",
  );
  assert.deepEqual(
    resolveKeyScopeAuthority(new Set(["ar.read"]), ["payroll.read"]),
    new Set(),
    "a valid scope its owner cannot use still authenticates, to nothing",
  );
});

test("POST refuses to mint a key whose scopes are omitted or empty", async () => {
  const omitted = await POST(jsonRequest({ name: "Omitted scopes" }));
  assert.equal(omitted.status, 400);
  assert.match((await omitted.json()).error, /at least one scope is required/);

  const empty = await POST(jsonRequest({ name: "Empty scopes", scopes: [] }));
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /at least one scope is required/);

  const unknown = await POST(jsonRequest({ name: "Unknown scopes", scopes: ["not.a.permission"] }));
  assert.equal(unknown.status, 400);
});

test("PATCH refuses to clear a key's scopes to an empty set", async () => {
  const cleared = await PATCH(jsonRequest({ id: randomUUID(), scopes: [] }, "PATCH"));
  assert.equal(cleared.status, 400);
  assert.match((await cleared.json()).error, /at least one scope is required/);

  // The only PATCH contract for narrowing is an explicit non-empty set; an
  // update that changes nothing still says so instead of touching storage.
  const nothing = await PATCH(jsonRequest({ id: randomUUID() }, "PATCH"));
  assert.equal(nothing.status, 400);
  assert.match((await nothing.json()).error, /nothing to update/);
});

// ---------------------------------------------------------------------------
// Real resolver seam against a live database.
// ---------------------------------------------------------------------------

function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  const messages: string[] = [];
  for (
    let current: unknown = error;
    current && typeof current === "object";
    current = (current as { cause?: unknown }).cause
  ) {
    messages.push(String((current as { message?: unknown }).message ?? ""));
  }
  return pattern.test(messages.join(" "));
}

function bearer(plaintext: string): Request {
  return new Request("http://openbooks.test/api/v1/gl/accounts", {
    headers: { authorization: `Bearer ${plaintext}` },
  });
}

async function seedOwner(orgId: string, permissions: string[]): Promise<string> {
  const userId = randomUUID();
  // File-local seed helper: stage fixture rows under the test bypass (the
  // shared createScratchUser precedent wraps call sites; a single body wrap
  // here covers every caller).
  return withBypassContext(async () => {
    const roleId = (await db.execute(sql`
      insert into app_roles (org_id, key, name, is_built_in, permissions)
      values (${orgId}, ${`api-owner-${userId.slice(0, 8)}`}, 'API Owner', false,
              ${JSON.stringify(permissions)}::jsonb)
      returning id`)).rows[0]!.id as string;
    // Users activate only once they hold a role (enforce_user_active_role_assignment).
    await db.execute(sql`
      insert into users (id, org_id, email, name, password_hash, is_active)
      values (${userId}, ${orgId}, ${`api-owner-${userId.slice(0, 8)}@scratch.test`}, 'API Owner', 'x', false)`);
    await db.execute(sql`
      insert into role_assignments (org_id, user_id, role_id)
      values (${orgId}, ${userId}, ${roleId})`);
    await db.execute(sql`update users set is_active = true where id = ${userId}`);
    return userId;
  });
}

async function insertKey(
  orgId: string,
  userId: string,
  name: string,
  scopes: string,
): Promise<{ id: string; plaintext: string }> {
  const gen = generateApiKey();
  const id = (await withBypassContext(() => db.execute(sql`
    insert into api_keys (org_id, user_id, name, key_prefix, key_hash, key_preview,
                          scopes, is_active, created_by, updated_by)
    values (${orgId}, ${userId}, ${name}, ${gen.keyPrefix}, ${gen.keyHash}, ${gen.keyPreview},
            ${scopes}::jsonb, true, ${userId}, ${userId})
    returning id`))).rows[0]!.id as string;
  return { id, plaintext: gen.plaintext };
}

async function waitUntilBlocked(blockerPid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const blocked = (await pool.query<{ blocked: boolean }>(
      "select exists(select 1 from pg_stat_activity where $1::int = any(pg_blocking_pids(pid))) as blocked",
      [blockerPid],
    )).rows[0]?.blocked;
    if (blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`credential use did not wait on blocker backend ${blockerPid}`);
}

test("API key use is refused when revocation commits before its final credential stamp", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const blocker = await pool.connect();
  let held = false;
  let pending: Promise<Awaited<ReturnType<typeof resolveApiKeyAuth>>> | undefined;
  try {
    const ownerId = await seedOwner(org.orgId, ["*"]);
    const key = await insertKey(org.orgId, ownerId, "racing revoke", '["gl.read"]');
    await blocker.query("begin");
    held = true;
    await blocker.query("select set_config('app.bypass_rls','on',true)");
    await blocker.query("update api_keys set is_active=false, key_hash=$2 where id=$1", [key.id, randomBytes(32).toString("hex")]);
    const pid = (await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

    pending = withOrgContext(org.orgId, () => resolveApiKeyAuth(bearer(key.plaintext)));
    await waitUntilBlocked(pid);
    await blocker.query("commit");
    held = false;
    assert.equal(await pending, null, "the request must not authenticate after revoke has committed");
  } finally {
    if (held) await blocker.query("rollback").catch(() => undefined);
    blocker.release();
    if (pending) await pending.catch(() => undefined);
    await dropScratchOrg(org.orgId);
  }
});

test("session validation is refused when revocation commits before its final liveness stamp", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const blocker = await pool.connect();
  const priorSecret = process.env.SESSION_SECRET;
  const secret = randomBytes(32).toString("hex");
  process.env.SESSION_SECRET = secret;
  let held = false;
  let pending: Promise<Awaited<ReturnType<typeof validateSessionToken>>> | undefined;
  try {
    const ownerId = await seedOwner(org.orgId, ["*"]);
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + 86_400_000);
    const expiresEpoch = Math.floor(expiresAt.getTime() / 1000);
    const payload = `v2.${sessionId}.${ownerId}.${expiresEpoch}`;
    const token = `${payload}.${createHmac("sha256", secret).update(sessionSigningInput(payload)).digest("base64url")}`;
    const hash = createHash("sha256").update(token).digest("hex");
    await withBypassContext(() => db.execute(sql`
      insert into auth_sessions(id,user_id,token_hash,auth_method,expires_at,last_seen_at)
      values (${sessionId},${ownerId},${hash},'password',${expiresAt},now() - interval '10 minutes')`));

    await blocker.query("begin");
    held = true;
    await blocker.query("select set_config('app.bypass_rls','on',true)");
    await blocker.query("update auth_sessions set revoked_at=now(), revocation_reason='user_revoked' where id=$1", [sessionId]);
    const pid = (await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

    pending = validateSessionToken(token);
    await waitUntilBlocked(pid);
    await blocker.query("commit");
    held = false;
    assert.equal(await pending, null, "a revoked session must not validate after the revocation commits");
  } finally {
    if (held) await blocker.query("rollback").catch(() => undefined);
    blocker.release();
    if (pending) await pending.catch(() => undefined);
    if (priorSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = priorSecret;
    await dropScratchOrg(org.orgId);
  }
});

test(
  "an explicitly narrow key grants exactly its selection against a powerful owner",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      actorState.orgId = org.orgId;
      const ownerId = await seedOwner(org.orgId, ["*"]);
      actorState.userId = ownerId;
      const key = await insertKey(org.orgId, ownerId, "narrow", '["gl.read"]');

      // Key resolution reads key/user/role rows through RLS like production's
      // request scope, so resolve under the org context.
      const auth = await withOrgContext(org.orgId, () => resolveApiKeyAuth(bearer(key.plaintext)));
      assert.ok(auth, "an explicit narrow scope must authenticate");
      assert.deepEqual([...auth.permissions].sort(), ["gl.read"]);
      assert.equal(canApi(auth, "gl.read"), true);
      assert.equal(canApi(auth, "gl.post"), false);
      assert.equal(canApi(auth, "ap.pay"), false);

      // Through the guarded v1 transport: the narrow permission passes, a
      // sibling the owner holds is still refused — the key never inherits.
      await withBypassContext(() => db.execute(sql`
        update orgs
           set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,apiAccess}', 'true'::jsonb)
         where id = ${org.orgId}`));
      const allowed = await withOrgContext(org.orgId, () => guardApiKey("gl.read", bearer(key.plaintext)));
      assert.ok(!(allowed instanceof NextResponse), "gl.read must pass the guarded transport");
      const denied = await withOrgContext(org.orgId, () => guardApiKey("ap.pay", bearer(key.plaintext)));
      assert.ok(denied instanceof NextResponse, "ap.pay must be refused by the guarded transport");
      assert.equal((denied as NextResponse).status, 403);
    } finally { await dropScratchOrg(org.orgId); }
  },
);

test(
  "a valid scope its owner cannot use still authenticates, to nothing",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      actorState.orgId = org.orgId;
      const ownerId = await seedOwner(org.orgId, ["ar.read"]);
      actorState.userId = ownerId;
      const key = await insertKey(org.orgId, ownerId, "inert", '["payroll.read"]');

      // Valid declaration, zero owner overlap: the original contract returns
      // a credential conferring nothing — never null, never inherited scope.
      const auth = await withOrgContext(org.orgId, () => resolveApiKeyAuth(bearer(key.plaintext)));
      assert.ok(auth, "a valid declaration authenticates even when the owner cannot use it");
      assert.deepEqual([...auth.permissions], []);
      assert.equal(canApi(auth, "ar.read"), false);
      assert.equal(canApi(auth, "payroll.read"), false);
    } finally { await dropScratchOrg(org.orgId); }
  },
);

test(
  "a minted key stores exactly its explicit selection and fails closed on residual junk",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const orgId = org.orgId;
      actorState.orgId = orgId;
      const ownerId = await seedOwner(orgId, ["*"]);
      actorState.userId = ownerId;

      const minted = await POST(jsonRequest({ name: "Sync", scopes: ["ap.pay", "gl.read"] }));
      assert.equal(minted.status, 201);
      const { id, plaintext } = (await minted.json()) as { id: string; plaintext: string };

      const row = (await withOrgContext(orgId, () => db.execute(sql`
        select scopes from api_keys where id = ${id} and org_id = ${orgId}`))).rows[0] as {
        scopes: string[];
      };
      // The route stores the normalized catalogue-ordered selection.
      assert.deepEqual(row.scopes, ["gl.read", "ap.pay"]);

      const auth = await withOrgContext(orgId, () => resolveApiKeyAuth(bearer(plaintext)));
      assert.ok(auth);
      assert.deepEqual([...auth.permissions].sort(), ["ap.pay", "gl.read"]);

      // A direct write can still plant a non-empty array of non-catalogue junk;
      // the resolver must grant it nothing (no wildcard, no partial credit).
      await withBypassContext(() => db.execute(sql`update api_keys set scopes = '["*"]'::jsonb where id = ${id}`));
      assert.equal(await withOrgContext(orgId, () => resolveApiKeyAuth(bearer(plaintext))), null);

      // And storage itself refuses to clear the key to an empty scope set.
      await assert.rejects(
        withBypassContext(() => db.execute(sql`update api_keys set scopes = '[]'::jsonb where id = ${id} and org_id = ${orgId}`)),
        (error: unknown) => errorChainMatches(error, /api_keys_scopes_non_empty/),
      );
    } finally { await dropScratchOrg(org.orgId); }
  },
);
