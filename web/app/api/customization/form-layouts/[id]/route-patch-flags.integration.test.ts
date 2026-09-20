import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression for PATCH /api/customization/form-layouts/:id.
// Collection POST coerces isDefault with !!, but the [id] PATCH wrote
// body.isDefault / body.isActive straight into boolean columns. A non-boolean
// JSON value reaches PostgreSQL, which either throws 22P02 (raw 500 through
// the route's catch-all) or coerces silently — the same unhandled-storage
// class already fixed on list-views PATCH, pdf-templates PATCH, and guarded
// on api-keys PATCH.

const stateKey = Symbol.for("openbooks.form-layout-patch-bool-test");
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
  const state = globalThis[Symbol.for('openbooks.form-layout-patch-bool-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
    return state.authz
  }
  export function can(authz, permission) {
    const permissions = authz?.permissions ?? new Set()
    if (permissions.has('*')) return true
    return permissions.has(permission)
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
    if (specifier === "../../../../../lib/authz" && context.parentURL?.includes("customization/form-layouts")) {
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

const routeUrl = "./route.ts?form-layout-patch-bool-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const LAYOUT_ID = "00000000-0000-4000-8000-000000000041";
const DEFAULT_ID = "00000000-0000-4000-8000-000000000042";
const ROLE_ID = "00000000-0000-4000-8000-000000000099";

async function seed(): Promise<{ orgId: string; actorId: string }> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Form Admin", "admin");
  await db.execute(sql`
    insert into form_layouts (id, org_id, record_type, name, layout, created_by, updated_by)
    values (${LAYOUT_ID}, ${org.orgId}, 'vendor_bill', 'Standard',
            '{"schemaVersion": 1, "recordType": "vendor_bill"}'::jsonb, ${actorId}, ${actorId})
    on conflict (id) do update set org_id = ${org.orgId}, is_default = false, is_active = true`);
  routeState.authz = {
    user: { orgId: org.orgId, id: actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  return { orgId: org.orgId, actorId };
}

function patchRequest(body: unknown): Request {
  return new Request(`http://localhost/api/customization/form-layouts/${LAYOUT_ID}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function storedFlags(orgId: string): Promise<{ isDefault: boolean; isActive: boolean }> {
  const r = await db.execute<{ isDefault: boolean; isActive: boolean }>(sql`
    select is_default as "isDefault", is_active as "isActive"
      from form_layouts where id = ${LAYOUT_ID} and org_id = ${orgId}`);
  return r.rows[0]!;
}

test(
  "PATCH refuses a non-boolean isDefault with a 400, never a storage 500",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await PATCH(patchRequest({ isDefault: "sometimes" }), {
      params: Promise.resolve({ id: LAYOUT_ID }),
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
      params: Promise.resolve({ id: LAYOUT_ID }),
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
      params: Promise.resolve({ id: LAYOUT_ID }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await storedFlags(f.orgId), { isDefault: true, isActive: true });
  },
);

test(
  "PATCH refuses an inactive default instead of storing a row resolve cannot see",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await PATCH(patchRequest({ isDefault: true, isActive: false }), {
      params: Promise.resolve({ id: LAYOUT_ID }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error), /inactive form cannot be the default/i);
    assert.match(String(body.error), /activate it/i);
    assert.deepEqual(await storedFlags(f.orgId), { isDefault: false, isActive: true });
  },
);

async function storedRoles(orgId: string): Promise<unknown> {
  const r = await db.execute<{ allowedRoles: unknown }>(sql`
    select allowed_roles as "allowedRoles"
      from form_layouts where id = ${LAYOUT_ID} and org_id = ${orgId}`);
  return r.rows[0]?.allowedRoles ?? null;
}

test(
  "PATCH refuses a truthy non-array allowedRoles and does not persist it",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await PATCH(patchRequest({ allowedRoles: { admin: true } }), {
      params: Promise.resolve({ id: LAYOUT_ID }),
    });
    assert.equal(res.status, 400);
    assert.match(String((await res.json()).error), /allowedRoles/);
    assert.equal(await storedRoles(f.orgId), null);
  },
);

test(
  "PATCH refuses a non-UUID allowedRoles string and does not persist it",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await PATCH(patchRequest({ allowedRoles: ["admin"] }), {
      params: Promise.resolve({ id: LAYOUT_ID }),
    });
    assert.equal(res.status, 400);
    assert.match(String((await res.json()).error), /allowedRoles/);
    assert.equal(await storedRoles(f.orgId), null);
  },
);

test(
  "PATCH persists a UUID allowedRoles list",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await PATCH(patchRequest({ allowedRoles: [ROLE_ID] }), {
      params: Promise.resolve({ id: LAYOUT_ID }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await storedRoles(f.orgId), [ROLE_ID]);
  },
);

test(
  "PATCH {isDefault:true} on a row that vanishes after loadOwn 404s and keeps the org default",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    await db.execute(sql`
      insert into form_layouts (id, org_id, record_type, name, is_default, layout, created_by, updated_by)
      values (${DEFAULT_ID}, ${f.orgId}, 'vendor_bill', 'Org Default', true,
              '{"schemaVersion": 1, "recordType": "vendor_bill"}'::jsonb, ${f.actorId}, ${f.actorId})
      on conflict (id) do update
        set org_id = excluded.org_id, is_default = true, is_active = true`);
    const original = db.execute.bind(db);
    let deleted = false;
    db.execute = (async (query: Parameters<typeof original>[0]) => {
      const result = await original(query);
      const row = result.rows[0] as { id?: string } | undefined;
      if (!deleted && row?.id === LAYOUT_ID) {
        deleted = true;
        await original(sql`delete from form_layouts where id = ${LAYOUT_ID} and org_id = ${f.orgId}`);
      }
      return result;
    }) as typeof db.execute;
    try {
      const res = await PATCH(patchRequest({ isDefault: true }), {
        params: Promise.resolve({ id: LAYOUT_ID }),
      });
      const body = await res.json();
      assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(body)}`);
      assert.notEqual((body as { ok?: unknown }).ok, true);
      const def = await db.execute<{ isDefault: boolean }>(sql`
        select is_default as "isDefault"
          from form_layouts where id = ${DEFAULT_ID} and org_id = ${f.orgId}`);
      assert.equal(def.rows[0]?.isDefault, true, "org default must survive a zero-row PATCH");
    } finally {
      db.execute = original;
    }
  },
);
