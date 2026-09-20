import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression for POST /api/customization/form-layouts.
// isDefault is coerced with !!, but isActive rode `${body.isActive ?? true}`
// straight into the boolean column: a non-boolean JSON value either throws
// 22P02 (raw 500 through the route's catch-all) or coerces silently — the
// same unhandled-storage class as the [id] PATCH flags.

const stateKey = Symbol.for("openbooks.form-layout-post-bool-test");
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
  const state = globalThis[Symbol.for('openbooks.form-layout-post-bool-test')]
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
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("customization/form-layouts/route")) {
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

const routeUrl = "./route.ts?form-layout-post-bool-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { defaultFormLayout } = await import("@openbooks/customization");
const { createScratchOrg, createScratchUser } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

async function seed(): Promise<{ orgId: string; actorId: string }> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Form Admin", "admin");
  routeState.authz = {
    user: { orgId: org.orgId, id: actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  return { orgId: org.orgId, actorId };
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/customization/form-layouts", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function layoutCount(orgId: string): Promise<number> {
  const r = await db.execute<{ c: number }>(sql`
    select count(*)::int as c from form_layouts where org_id = ${orgId}`);
  return Number(r.rows[0]?.c ?? 0);
}

test(
  "POST refuses a non-boolean isActive with a 400, never a storage 500",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await POST(
      postRequest({
        recordType: "vendor_bill",
        name: "Custom",
        layout: defaultFormLayout("vendor_bill"),
        isActive: "eventually",
      }),
    );
    assert.equal(res.status, 400);
    assert.match(String((await res.json()).error), /isActive/);
    assert.equal(await layoutCount(f.orgId), 0, "rejected create must store no row");
  },
);

test(
  "POST refuses a truthy non-array allowedRoles and stores no row",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await POST(
      postRequest({
        recordType: "vendor_bill",
        name: "Gated",
        layout: defaultFormLayout("vendor_bill"),
        allowedRoles: { admin: true },
      }),
    );
    assert.equal(res.status, 400);
    assert.match(String((await res.json()).error), /allowedRoles/);
    assert.equal(await layoutCount(f.orgId), 0, "rejected create must store no row");
  },
);

test(
  "POST refuses a non-UUID allowedRoles string and stores no row",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await POST(
      postRequest({
        recordType: "vendor_bill",
        name: "Keyed",
        layout: defaultFormLayout("vendor_bill"),
        allowedRoles: ["admin"],
      }),
    );
    assert.equal(res.status, 400);
    assert.match(String((await res.json()).error), /allowedRoles/);
    assert.equal(await layoutCount(f.orgId), 0, "rejected create must store no row");
  },
);

const ROLE_ID = "00000000-0000-4000-8000-000000000099";

test(
  "POST persists a UUID allowedRoles list",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await POST(
      postRequest({
        recordType: "vendor_bill",
        name: "Role Gated",
        layout: defaultFormLayout("vendor_bill"),
        allowedRoles: [ROLE_ID],
      }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id?: string };
    const stored = await db.execute<{ allowedRoles: unknown }>(sql`
      select allowed_roles as "allowedRoles"
        from form_layouts where org_id = ${f.orgId} and id = ${body.id}`);
    assert.deepEqual(stored.rows[0]?.allowedRoles, [ROLE_ID]);
  },
);

test(
  "POST still accepts an omitted or real-boolean isActive",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const implicit = await POST(
      postRequest({
        recordType: "vendor_bill",
        name: "Implicit",
        layout: defaultFormLayout("vendor_bill"),
      }),
    );
    assert.equal(implicit.status, 200);
    const explicit = await POST(
      postRequest({
        recordType: "vendor_bill",
        name: "Explicit",
        layout: defaultFormLayout("vendor_bill"),
        isActive: false,
      }),
    );
    assert.equal(explicit.status, 200);
    assert.equal(await layoutCount(f.orgId), 2);
  },
);

test(
  "POST refuses an inactive default instead of storing a row resolve cannot see",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await POST(
      postRequest({
        recordType: "vendor_bill",
        name: "Hidden default",
        layout: defaultFormLayout("vendor_bill"),
        isDefault: true,
        isActive: false,
      }),
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error), /inactive form cannot be the default/i);
    assert.match(String(body.error), /activate it/i);
    assert.equal(await layoutCount(f.orgId), 0, "rejected create must store no row");
  },
);
