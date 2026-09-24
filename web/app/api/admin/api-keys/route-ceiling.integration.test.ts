import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";
import type { SessionUser } from "../../../../lib/auth";

/**
 * F21 privilege-ceiling coverage for /api/admin/api-keys: a key-manager must
 * not grant scopes above their own authority, because use-time authentication
 * intersects key scopes with the OWNER (not the editor) — a widened key
 * amplifies into real authority through its owner.
 *
 * Seams: only the session identity is stubbed. The route, the authz gate
 * (real role/override/lens resolution), storage, audit, and
 * `resolveApiKeyAuth`/`canApi` are all real, against a synthetic scratch org.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const session: { user: SessionUser | null } = { user: null };

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function currentUser(){return globalThis.__apiKeysCeilingSession.user}",
      };
    }
    return nextResolve(specifier, context);
  },
});

(Object.assign(globalThis, { __apiKeysCeilingSession: session }) as unknown);

const routeUrl = "./route.ts?api-keys-ceiling";
const { POST, PATCH } = (await import(routeUrl)) as typeof import("./route.ts");
const { canApi, generateApiKey, resolveApiKeyAuth } = await import("../../../../lib/api-auth");
hooks.deregister();

function become(userId: string, orgId: string): void {
  session.user = {
    id: userId,
    orgId,
    name: "ceiling actor",
    email: "actor@scratch.test",
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
}

function jsonRequest(body: unknown, method: "POST" | "PATCH" = "POST"): Request {
  return new Request("http://openbooks.test/api/admin/api-keys", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function bearer(plaintext: string): Request {
  return new Request("http://openbooks.test/api/v1/gl/accounts", {
    headers: { authorization: `Bearer ${plaintext}` },
  });
}

async function setRole(orgId: string, key: string, permissions: string[], restriction: unknown = null): Promise<void> {
  await withBypassContext(() => db.execute(sql`
    update app_roles
       set permissions = ${JSON.stringify(permissions)}::jsonb
     where org_id = ${orgId} and key = ${key}`));
  if (restriction === null) {
    // Unrestricted is an explicit stored policy ('all'), never SQL NULL —
    // the column is NOT NULL DEFAULT '{"mode": "all"}'.
    await withBypassContext(() => db.execute(sql`
      update app_roles
         set subsidiary_restriction = '{"mode": "all"}'::jsonb
       where org_id = ${orgId} and key = ${key}`));
  } else {
    await withBypassContext(() => db.execute(sql`
      update app_roles
         set subsidiary_restriction = ${JSON.stringify(restriction)}::jsonb
       where org_id = ${orgId} and key = ${key}`));
  }
}

async function enableApi(orgId: string): Promise<void> {
  await withBypassContext(() => db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,apiAccess}', 'true'::jsonb)
     where id = ${orgId}`));
}

async function insertKey(orgId: string, userId: string, scopes: string[]): Promise<{ id: string; plaintext: string }> {
  const gen = generateApiKey();
  const id = (await withBypassContext(() => db.execute(sql`
    insert into api_keys (org_id, user_id, name, key_prefix, key_hash, key_preview,
                          scopes, is_active, created_by, updated_by)
    values (${orgId}, ${userId}, 'ceiling key', ${gen.keyPrefix}, ${gen.keyHash}, ${gen.keyPreview},
            ${JSON.stringify(scopes)}::jsonb, true, ${userId}, ${userId})
    returning id`))).rows[0]!.id as string;
  return { id, plaintext: gen.plaintext };
}

async function keyScopes(orgId: string, id: string): Promise<string[]> {
  const row = (await withBypassContext(() => db.execute(sql`
    select scopes from api_keys where id = ${id} and org_id = ${orgId}`))).rows[0] as {
    scopes: string[];
  };
  return row.scopes;
}

test(
  "a manager with only api.keys.manage cannot widen another owner's key, and the token is unchanged",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await enableApi(org.orgId);
      const owner = await withBypassContext(() => createScratchUser(org.orgId, "Key Owner", "key_owner"));
      const editor = await withBypassContext(() => createScratchUser(org.orgId, "Key Manager", "key_manager"));
      // The owner HOLDS payroll.read while the editor does not: on a broken
      // route the widened key would really amplify, so this exercises the
      // actual primitive rather than asserting a 403 alone.
      await setRole(org.orgId, "key_owner", ["ar.read", "payroll.read"]);
      await setRole(org.orgId, "key_manager", ["ar.read", "api.keys.manage"]);
      const key = await insertKey(org.orgId, owner, ["ar.read"]);

      // Before the attack the REAL resolver grants the narrow selection.
      const before = await withOrgContext(org.orgId, () => resolveApiKeyAuth(bearer(key.plaintext)));
      assert.ok(before, "the key must authenticate");
      assert.equal(canApi(before, "ar.read"), true);
      assert.equal(canApi(before, "payroll.read"), false);

      become(editor, org.orgId);
      const response = await PATCH(jsonRequest({ id: key.id, scopes: ["ar.read", "payroll.read"] }, "PATCH"));
      assert.equal(response.status, 403);
      const payload = (await response.json()) as { error: string; missing: string[] };
      assert.match(payload.error, /cannot grant permissions you do not hold: payroll\.read/);
      assert.deepEqual(payload.missing, ["payroll.read"]);

      // Storage is unchanged, and the REAL resolver still grants only the
      // original selection: the refused widening conferred nothing.
      assert.deepEqual(await keyScopes(org.orgId, key.id), ["ar.read"]);
      const auth = await withOrgContext(org.orgId, () => resolveApiKeyAuth(bearer(key.plaintext)));
      assert.ok(auth, "the key must still authenticate");
      assert.equal(canApi(auth, "ar.read"), true);
      assert.equal(canApi(auth, "payroll.read"), false);
    } finally {
      session.user = null;
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a manager holding the scope may widen, and the token gains exactly that authority",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await enableApi(org.orgId);
      const owner = await withBypassContext(() => createScratchUser(org.orgId, "Key Owner", "key_owner"));
      const editor = await withBypassContext(() => createScratchUser(org.orgId, "Key Manager", "key_manager"));
      await setRole(org.orgId, "key_owner", ["ar.read", "payroll.read"]);
      await setRole(org.orgId, "key_manager", ["ar.read", "payroll.read", "api.keys.manage"]);
      const key = await insertKey(org.orgId, owner, ["ar.read"]);

      become(editor, org.orgId);
      const response = await PATCH(jsonRequest({ id: key.id, scopes: ["ar.read", "payroll.read"] }, "PATCH"));
      assert.equal(response.status, 200);

      assert.deepEqual(await keyScopes(org.orgId, key.id), ["ar.read", "payroll.read"]);
      const auth = await withOrgContext(org.orgId, () => resolveApiKeyAuth(bearer(key.plaintext)));
      assert.ok(auth);
      assert.equal(canApi(auth, "ar.read"), true);
      assert.equal(canApi(auth, "payroll.read"), true);
    } finally {
      session.user = null;
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "creation above the editor's authority is refused with no key minted",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await enableApi(org.orgId);
      const editor = await withBypassContext(() => createScratchUser(org.orgId, "Key Manager", "key_manager"));
      await setRole(org.orgId, "key_manager", ["ar.read", "api.keys.manage"]);

      become(editor, org.orgId);
      const response = await POST(jsonRequest({ name: "escalated", scopes: ["payroll.read"] }));
      assert.equal(response.status, 403);
      assert.match(((await response.json()) as { error: string }).error, /cannot grant permissions you do not hold/);

      const count = (await withBypassContext(() => db.execute(sql`
        select count(*)::int as n from api_keys where org_id = ${org.orgId}`))).rows[0] as { n: number };
      assert.equal(count.n, 0);
    } finally {
      session.user = null;
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "resume refuses re-enabled authority above the ceiling but permits inert scopes",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await enableApi(org.orgId);
      const owner = await withBypassContext(() => createScratchUser(org.orgId, "Key Owner", "key_owner"));
      const editor = await withBypassContext(() => createScratchUser(org.orgId, "Key Manager", "key_manager"));
      await setRole(org.orgId, "key_owner", ["ar.read", "payroll.read"]);
      await setRole(org.orgId, "key_manager", ["ar.read", "api.keys.manage"]);
      const key = await insertKey(org.orgId, owner, ["ar.read", "payroll.read"]);

      become(editor, org.orgId);
      assert.equal((await PATCH(jsonRequest({ id: key.id, isActive: false }, "PATCH"))).status, 200);

      // The owner still holds payroll.read: resuming would re-enable it.
      const refused = await PATCH(jsonRequest({ id: key.id, isActive: true }, "PATCH"));
      assert.equal(refused.status, 403);
      assert.match(
        ((await refused.json()) as { error: string }).error,
        /cannot grant permissions you do not hold: payroll\.read/,
      );

      // Once the owner loses payroll.read the same resume re-enables only
      // ar.read — inside the ceiling — and the token authorizes exactly that.
      await setRole(org.orgId, "key_owner", ["ar.read"]);
      const resumed = await PATCH(jsonRequest({ id: key.id, isActive: true }, "PATCH"));
      assert.equal(resumed.status, 200);
      const auth = await withOrgContext(org.orgId, () => resolveApiKeyAuth(bearer(key.plaintext)));
      assert.ok(auth, "the resumed key must authenticate");
      assert.equal(canApi(auth, "ar.read"), true);
      assert.equal(canApi(auth, "payroll.read"), false);
    } finally {
      session.user = null;
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "widening a deactivated owner's key waits for reactivation",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await enableApi(org.orgId);
      const owner = await withBypassContext(() => createScratchUser(org.orgId, "Key Owner", "key_owner"));
      const editor = await withBypassContext(() => createScratchUser(org.orgId, "Key Manager", "key_manager"));
      await setRole(org.orgId, "key_owner", ["ar.read", "payroll.read"]);
      await setRole(org.orgId, "key_manager", ["ar.read", "payroll.read", "api.keys.manage"]);
      const key = await insertKey(org.orgId, owner, ["ar.read"]);

      await withBypassContext(() => db.execute(sql`update users set is_active = false where id = ${owner}`));
      become(editor, org.orgId);
      const refused = await PATCH(jsonRequest({ id: key.id, scopes: ["ar.read", "payroll.read"] }, "PATCH"));
      assert.equal(refused.status, 409);
      assert.match(
        ((await refused.json()) as { error: string }).error,
        /reactivate the owner before widening/,
      );
      assert.deepEqual(await keyScopes(org.orgId, key.id), ["ar.read"]);

      await withBypassContext(() => db.execute(sql`update users set is_active = true where id = ${owner}`));
      const allowed = await PATCH(jsonRequest({ id: key.id, scopes: ["ar.read", "payroll.read"] }, "PATCH"));
      assert.equal(allowed.status, 200);
    } finally {
      session.user = null;
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a subsidiary-scoped editor cannot widen an unrestricted owner's key, even for a held permission",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await enableApi(org.orgId);
      const owner = await withBypassContext(() => createScratchUser(org.orgId, "Key Owner", "key_owner"));
      const editor = await withBypassContext(() => createScratchUser(org.orgId, "Scoped Manager", "scoped_manager"));
      await setRole(org.orgId, "key_owner", ["ar.read", "payroll.read"]);
      // The editor HOLDS payroll.read but sees only the root subsidiary.
      await setRole(org.orgId, "scoped_manager", ["ar.read", "payroll.read", "api.keys.manage"], {
        mode: "list",
        subsidiaryIds: [org.subsidiaryId],
      });
      const key = await insertKey(org.orgId, owner, ["ar.read"]);

      become(editor, org.orgId);
      const refused = await PATCH(jsonRequest({ id: key.id, scopes: ["ar.read", "payroll.read"] }, "PATCH"));
      assert.equal(refused.status, 403);
      assert.match(
        ((await refused.json()) as { error: string }).error,
        /across subsidiaries you cannot see/,
      );
      assert.deepEqual(await keyScopes(org.orgId, key.id), ["ar.read"]);

      // The same widening through an equally-scoped owner is legitimate.
      await setRole(org.orgId, "key_owner", ["ar.read", "payroll.read"], {
        mode: "list",
        subsidiaryIds: [org.subsidiaryId],
      });
      const allowed = await PATCH(jsonRequest({ id: key.id, scopes: ["ar.read", "payroll.read"] }, "PATCH"));
      assert.equal(allowed.status, 200);
      assert.deepEqual(await keyScopes(org.orgId, key.id), ["ar.read", "payroll.read"]);
    } finally {
      session.user = null;
      await dropScratchOrg(org.orgId);
    }
  },
);
