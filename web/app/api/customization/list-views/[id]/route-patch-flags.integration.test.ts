import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression for PATCH /api/customization/list-views/:id.
// Collection POST refuses a non-boolean isDefault. The [id] PATCH wrote
// body.isDefault / body.isActive straight into boolean columns. A non-boolean
// JSON value reaches PostgreSQL, which either throws 22P02 (raw 500 with a
// driver message through the route's catch-all) or silently coerces
// ('yes'::boolean = true) — the same unhandled-storage-error class the
// api-keys route guards with a strict-boolean check.

const stateKey = Symbol.for("openbooks.list-view-patch-bool-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.list-view-patch-bool-test')]
  export async function getAuthz() {
    return state.authz
  }
  export function can(authz, permission) {
    const permissions = authz?.permissions ?? new Set()
    if (permissions.has('*')) return true
    if (permissions.has(permission)) return true
    const ns = permission.split('.')[0]
    return permissions.has(ns + '.*')
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (specifier === "../../../../../lib/authz" && context.parentURL?.includes("customization/list-views")) {
      return { url: "mock:authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?list-view-patch-bool-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const VIEW_ID = "00000000-0000-4000-8000-000000000021";

async function seed(): Promise<{ orgId: string; actorId: string }> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "View Owner", "admin");
  await db.execute(sql`
    insert into list_views (id, org_id, record_type, name, scope, owner_id, is_default, is_active, config, created_by, updated_by)
    values (${VIEW_ID}, ${org.orgId}, 'vendor_bill', 'My bills', 'user', ${actorId}, false, true,
            '{"schemaVersion": 1, "recordType": "vendor_bill"}'::jsonb, ${actorId}, ${actorId})
    on conflict (id) do update set org_id = ${org.orgId}, owner_id = ${actorId}, is_default = false, is_active = true`);
  routeState.authz = {
    user: { orgId: org.orgId, id: actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  return { orgId: org.orgId, actorId };
}

function patchRequest(body: unknown): Request {
  return new Request(`http://localhost/api/customization/list-views/${VIEW_ID}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function storedFlags(orgId: string): Promise<{ isDefault: boolean; isActive: boolean }> {
  const r = await db.execute<{ isDefault: boolean; isActive: boolean }>(sql`
    select is_default as "isDefault", is_active as "isActive"
      from list_views where id = ${VIEW_ID} and org_id = ${orgId}`);
  return r.rows[0]!;
}

test(
  "PATCH refuses a non-boolean isDefault with a 400, never a storage 500",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await PATCH(patchRequest({ isDefault: "sometimes" }), {
      params: Promise.resolve({ id: VIEW_ID }),
    });
    assert.equal(res.status, 400);
    assert.match(String((await res.json()).error), /isDefault/);
    assert.deepEqual(await storedFlags(f.orgId), { isDefault: false, isActive: true });
  },
);

test(
  "PATCH refuses a non-boolean isActive with a 400, never a storage 500",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await PATCH(patchRequest({ isActive: "eventually" }), {
      params: Promise.resolve({ id: VIEW_ID }),
    });
    assert.equal(res.status, 400);
    assert.match(String((await res.json()).error), /isActive/);
    assert.deepEqual(await storedFlags(f.orgId), { isDefault: false, isActive: true });
  },
);

test(
  "PATCH still accepts real booleans for both flags",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await PATCH(patchRequest({ isDefault: true, isActive: true }), {
      params: Promise.resolve({ id: VIEW_ID }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await storedFlags(f.orgId), { isDefault: true, isActive: true });
  },
);

test(
  "PATCH refuses an inactive personal isDefault instead of storing a flag resolve cannot see",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await PATCH(patchRequest({ isDefault: true, isActive: false }), {
      params: Promise.resolve({ id: VIEW_ID }),
    });
    assert.notEqual(res.status, 200, "an inactive personal default must not report success");
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error), /inactive view cannot be the default/i);
    assert.match(String(body.error), /activate it/i);
    assert.deepEqual(await storedFlags(f.orgId), { isDefault: false, isActive: true });
  },
);
