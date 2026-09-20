import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression for PATCH /api/pdf-templates/:id. Collection POST
// coerces isDefault with !! (always a real boolean), but the [id] PATCH wrote
// body.isDefault / body.isActive straight into boolean columns. A non-boolean
// JSON value reaches PostgreSQL, which either throws 22P02 (raw 500 through
// the route's catch-all) or coerces silently — the same unhandled-storage
// class already fixed on list-views PATCH and guarded on api-keys PATCH.

const stateKey = Symbol.for("openbooks.pdf-template-patch-bool-test");
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
  const state = globalThis[Symbol.for('openbooks.pdf-template-patch-bool-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
    return state.authz
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
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("pdf-templates")) {
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

const routeUrl = "./route.ts?pdf-template-patch-bool-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const TEMPLATE_ID = "00000000-0000-4000-8000-000000000031";

async function seed(): Promise<{ orgId: string; actorId: string }> {
  return withBypassContext(async () => {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Template Admin", "admin");
  await db.execute(sql`
    insert into pdf_templates (id, org_id, record_type, name, source_html, compiled_html, created_by, updated_by)
    values (${TEMPLATE_ID}, ${org.orgId}, 'customer_invoice', 'Standard', '<p>Hi</p>', '<p>Hi</p>', ${actorId}, ${actorId})
    on conflict (id) do update set org_id = ${org.orgId}, is_default = false, is_active = true,
      source_html = '<p>Hi</p>', compiled_html = '<p>Hi</p>'`);
  routeState.authz = {
    user: { orgId: org.orgId, id: actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  return { orgId: org.orgId, actorId };
  });
}

async function storedFlags(orgId: string): Promise<{ isDefault: boolean; isActive: boolean }> {
  const r = await withOrgContext(orgId, () => db.execute<{ isDefault: boolean; isActive: boolean }>(sql`
    select is_default as "isDefault", is_active as "isActive"
      from pdf_templates where id = ${TEMPLATE_ID} and org_id = ${orgId}`));
  return r.rows[0]!;
}

function patchRequest(body: unknown): Request {
  return new Request(`http://localhost/api/pdf-templates/${TEMPLATE_ID}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

test(
  "PATCH refuses a non-boolean isDefault with a 400, never a storage 500",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    // The mocked session gate carries no connection scope; the handler runs
    // under the org, as the middleware provides in production.
    const res = await withOrgContext(f.orgId, () => PATCH(patchRequest({ isDefault: "sometimes" }), {
      params: Promise.resolve({ id: TEMPLATE_ID }),
    }));
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
    const res = await withOrgContext(f.orgId, () => PATCH(patchRequest({ isActive: "eventually" }), {
      params: Promise.resolve({ id: TEMPLATE_ID }),
    }));
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
    const res = await withOrgContext(f.orgId, () => PATCH(patchRequest({ isDefault: true, isActive: false }), {
      params: Promise.resolve({ id: TEMPLATE_ID }),
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(await storedFlags(f.orgId), { isDefault: true, isActive: false });
  },
);
