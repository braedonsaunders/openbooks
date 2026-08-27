import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, env } from "@openbooks/engine/src/db.ts";
import { PERMISSION_CATALOGUE } from "@openbooks/engine/src/permissions.ts";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/src/test-fixtures.ts";

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

test("migration 0031 freezes legacy empty scope sets into the explicit current catalogue snapshot", () => {
  // The backfill targets exactly the legacy empty rows and stamps an explicit
  // snapshot — never a sentinel, wildcard, or inherit marker.
  assert.match(migration, /UPDATE public\.api_keys/);
  assert.match(migration, /WHERE scopes = '\[\]'::jsonb/);
  assert.doesNotMatch(migration, /'inherit_all'|'full_scope'|'\*'/);
  const snapshot = JSON.parse(
    migration.match(/SET scopes = '(\[[\s\S]*?\])'::jsonb/)?.[1] ?? "null",
  ) as string[];
  assert.deepEqual(snapshot, [...PERMISSION_CATALOGUE]);

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

// A real scratch org when a database is available, created lazily (inside the
// DB-gated tests) so test registration never blocks on the database and the
// runner's --test-force-exit cannot truncate the file.
type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>;
let scratchPromise: Promise<ScratchOrg> | null = null;
function ensureScratch(): Promise<ScratchOrg> {
  scratchPromise ??= createScratchOrg();
  return scratchPromise;
}
after(async () => {
  if (scratchPromise) await dropScratchOrg((await scratchPromise).orgId);
});

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
}

async function insertKey(
  orgId: string,
  userId: string,
  name: string,
  scopes: string,
): Promise<{ id: string; plaintext: string }> {
  const gen = generateApiKey();
  const id = (await db.execute(sql`
    insert into api_keys (org_id, user_id, name, key_prefix, key_hash, key_preview,
                          scopes, is_active, created_by, updated_by)
    values (${orgId}, ${userId}, ${name}, ${gen.keyPrefix}, ${gen.keyHash}, ${gen.keyPreview},
            ${scopes}::jsonb, true, ${userId}, ${userId})
    returning id`)).rows[0]!.id as string;
  return { id, plaintext: gen.plaintext };
}

test(
  "an explicitly narrow key grants exactly its selection against a powerful owner",
  { skip: !DB },
  async () => {
    const org = await ensureScratch();
    actorState.orgId = org.orgId;
    const ownerId = await seedOwner(org.orgId, ["*"]);
    actorState.userId = ownerId;
    const key = await insertKey(org.orgId, ownerId, "narrow", '["gl.read"]');

    const auth = await resolveApiKeyAuth(bearer(key.plaintext));
    assert.ok(auth, "an explicit narrow scope must authenticate");
    assert.deepEqual([...auth.permissions].sort(), ["gl.read"]);
    assert.equal(canApi(auth, "gl.read"), true);
    assert.equal(canApi(auth, "gl.post"), false);
    assert.equal(canApi(auth, "ap.pay"), false);

    // Through the guarded v1 transport: the narrow permission passes, a
    // sibling the owner holds is still refused — the key never inherits.
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,apiAccess}', 'true'::jsonb)
       where id = ${org.orgId}`);
    const allowed = await guardApiKey("gl.read", bearer(key.plaintext));
    assert.ok(!(allowed instanceof NextResponse), "gl.read must pass the guarded transport");
    const denied = await guardApiKey("ap.pay", bearer(key.plaintext));
    assert.ok(denied instanceof NextResponse, "ap.pay must be refused by the guarded transport");
    assert.equal((denied as NextResponse).status, 403);
  },
);

test(
  "a minted key stores exactly its explicit selection and fails closed on residual junk",
  { skip: !DB },
  async () => {
    const org = await ensureScratch();
    const orgId = org.orgId;
    actorState.orgId = orgId;
    const ownerId = await seedOwner(orgId, ["*"]);
    actorState.userId = ownerId;

    const minted = await POST(jsonRequest({ name: "Sync", scopes: ["ap.pay", "gl.read"] }));
    assert.equal(minted.status, 201);
    const { id, plaintext } = (await minted.json()) as { id: string; plaintext: string };

    const row = (await db.execute(sql`
      select scopes from api_keys where id = ${id} and org_id = ${orgId}`)).rows[0] as {
      scopes: string[];
    };
    // The route stores the normalized catalogue-ordered selection.
    assert.deepEqual(row.scopes, ["gl.read", "ap.pay"]);

    const auth = await resolveApiKeyAuth(bearer(plaintext));
    assert.ok(auth);
    assert.deepEqual([...auth.permissions].sort(), ["ap.pay", "gl.read"]);

    // A direct write can still plant a non-empty array of non-catalogue junk;
    // the resolver must grant it nothing (no wildcard, no partial credit).
    await db.execute(sql`update api_keys set scopes = '["*"]'::jsonb where id = ${id}`);
    assert.equal(await resolveApiKeyAuth(bearer(plaintext)), null);

    // And storage itself refuses to clear the key to an empty scope set.
    await assert.rejects(
      db.execute(sql`update api_keys set scopes = '[]'::jsonb where id = ${id} and org_id = ${orgId}`),
      (error: unknown) => errorChainMatches(error, /api_keys_scopes_non_empty/),
    );
  },
);
