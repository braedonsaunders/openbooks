import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, env, withBypassContext, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import { PERMISSION_CATALOGUE } from "@openbooks/engine/src/organization/permissions.ts";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";

/**
 * Regression coverage for the empty-scopes defect in the API-key contract:
 * POST defaulted an omitted scopes field to [] and resolveApiKeyAuth treated
 * an empty scope array as "inherit the owner's full effective permission
 * set", so a missing UI/API field minted a full financial-access credential.
 *
 * The seams here are the real ones production takes: the real
 * `/api/admin/api-keys` route handlers (only the session gate is seammed to a
 * fixture actor) and the real `resolveApiKeyAuth`/`guardApiKey` pair against
 * a real database, plus direct migration/source evidence that legacy empty
 * scope sets freeze into the explicit permission-catalogue snapshot.
 */

const DB = !!env.OPENBOOKS_DB_URL;
const migration = readFileSync("schema/migrations/generated/0031_api_key_explicit_scopes.sql", "utf8");

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
    return { user: { orgId: state.orgId, id: state.userId } }
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
test("migration 0031 freezes legacy empty scope sets into the explicit current catalogue snapshot", () => {
  // The backfill targets exactly the legacy empty rows and stamps an explicit
  // snapshot — never a sentinel, wildcard, or inherit marker.
  assert.match(migration, /UPDATE public\.api_keys/);
  assert.match(migration, /WHERE scopes = '\[\]'::jsonb/);
  assert.doesNotMatch(migration, /'inherit_all'|'full_scope'|'\*'/);
  const snapshot = JSON.parse(
    migration.match(/SET scopes = '(\[[\s\S]*?\])'::jsonb/)?.[1] ?? "null",
  ) as string[];
  // The snapshot is the catalogue AS OF 0031. Permissions reviewed into the
  // catalogue afterwards are listed here explicitly so growth is deliberate:
  // a key that is neither in the frozen snapshot nor in this list fails.
  const addedAfter0031 = new Set<string>([
    // 0160 allocation kernel (rules, drivers, runs, approvals)
    "allocations.read",
    "allocations.manage",
    "allocations.run",
    "allocations.approve",
    // In-app issue reporting, added with the feedback inbox. Its own key
    // because filing a report sends generalized text OUT of the installation
    // to the operator, which no other permission implies.
    "feedback.use",
    // 0184/0185 HRM employment foundation: employment records are a
    // distinct authority from payroll, so they carry their own keys.
    "hrm.employment.read",
    "hrm.employment.manage",
    "hrm.employment.approve",
    // 0192 HRM positions: the headcount plan is post-snapshot too — a legacy
    // key does not gain it; a key that needs it names the scopes.
    "hrm.position.read",
    "hrm.position.manage",
    // 0193 HRM process checklists: checklist state is governed by the
    // process gate, not the employment one, so it carries its own keys.
    "hrm.process.read",
    "hrm.process.manage",
    // 0194 HRM leave and attendance: post-snapshot like the rest of HRM.
    "hrm.leave.read",
    "hrm.leave.request",
    "hrm.leave.approve",
    "hrm.leave.manage",
    // 0195 HRM recruiting: requisitions, candidates, the funnel, interviews
    // and offers carry their own read/manage pair, post-snapshot like the
    // rest of HRM.
    "hrm.recruiting.read",
    "hrm.recruiting.manage",
    // 0196 HRM performance and retention: post-snapshot like the rest of
    // HRM — reviews carry assessments of named people.
    "hrm.performance.read",
    "hrm.performance.manage",
    "hrm.retention.read",
    // 0197 HRM benefits: post-snapshot like the rest of HRM.
    "hrm.benefits.read",
    "hrm.benefits.manage",
    // 0198 HRM self-service: self.read/request scope to the party behind
    // the login and ride on every built-in role; team.read/manage resolve
    // structurally by holding direct reports. Post-snapshot like the rest.
    "hrm.self.read",
    "hrm.self.request",
    "hrm.team.read",
    "hrm.team.manage",
    // HR-12 begin: 0221/0222 HRM compensation — who is paid what and
    // whether pay is equitable carry their own read/manage/approve keys,
    // post-snapshot like the rest of HRM.
    "hrm.compensation.read",
    "hrm.compensation.manage",
    "hrm.compensation.approve",
    // HR-12 end
    // HR-13 begin: 0223/0224 construction compliance — post-snapshot
    // like the rest of HRM.
    "hrm.construction.read",
    "hrm.construction.manage",
    // HR-13 end
    // HR-14 begin: 0225 certifications and dispatch gating —
    // post-snapshot like the rest of HRM.
    "hrm.certifications.read",
    "hrm.certifications.manage",
    // HR-14 end
    // HR-16 automations (pre-existing gap, fixed alongside: the keys
    // were catalogued but never pinned here, so this test was red).
    "automations.read",
    "automations.manage",
    "automations.run",
    // HR-16 end
    // HR-19 begin: 0230 HRM documents and surveys — post-snapshot like
    // the rest of HRM.
    "hrm.documents.read",
    "hrm.documents.manage",
    "hrm.surveys.manage",
    // HR-19 end
  ]);
  for (const key of addedAfter0031) {
    assert.ok((PERMISSION_CATALOGUE as readonly string[]).includes(key), `${key} must exist in the catalogue`);
    assert.ok(!snapshot.includes(key), `${key} post-dates 0031 and must not be in its frozen snapshot`);
  }
  assert.deepEqual(
    snapshot,
    (PERMISSION_CATALOGUE as readonly string[]).filter((key) => !addedAfter0031.has(key)),
  );

  // Storage owns the invariant afterwards: the empty shape is unrepresentable
  // and the '[]' default is gone, so omitted scopes fail at write time.
  assert.match(migration, /ALTER COLUMN scopes DROP DEFAULT/);
  assert.match(
    migration,
    /ADD CONSTRAINT api_keys_scopes_non_empty\s+CHECK \(jsonb_typeof\(scopes\) = 'array' AND jsonb_array_length\(scopes\) > 0\)/,
  );
});

test("the resolver fails closed on empty, malformed, or non-catalogue scope sets", () => {
  const source = readFileSync("web/lib/api-auth.ts", "utf8");
  // The inherit branch is gone; an empty or malformed scope array resolves to
  // nothing instead of the owner's permission set.
  assert.match(
    source,
    /if \(!Array\.isArray\(keyRow\.scopes\) \|\| keyRow\.scopes\.length === 0\) return null;/,
  );
  assert.match(
    source,
    /if \(scopeSet\.size === 0\) return null;/,
  );
  assert.doesNotMatch(
    source,
    /Array\.isArray\(keyRow\.scopes\) \? keyRow\.scopes : \[\]/,
  );
  assert.doesNotMatch(source, /Empty scopes = inherit/);
  // Scopes are exact catalogue keys only — a direct-write wildcard is inert.
  assert.match(source, /keyRow\.scopes\.filter\(\(s\) => isCataloguePermission\(s\)\)/);
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
