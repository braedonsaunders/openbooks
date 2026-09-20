import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression for POST /api/customization/list-views.
// isDefault must be a real boolean when present. A truthy non-boolean
// (including the string "false") used to coerce via !! and steal the org default.

const stateKey = Symbol.for("openbooks.list-view-post-bool-integration");
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
  const state = globalThis[Symbol.for('openbooks.list-view-post-bool-integration')]
  export async function getAuthz() {
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
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("customization/list-views/route")) {
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

const routeUrl = "./route.ts?list-view-post-bool-integration";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { defaultListView } = await import("@openbooks/customization");
const { createScratchOrg, createScratchUser } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

async function seed(): Promise<{ orgId: string; actorId: string }> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "View Admin", "admin");
  routeState.authz = {
    user: { orgId: org.orgId, id: actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  return { orgId: org.orgId, actorId };
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/customization/list-views", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function viewCount(orgId: string): Promise<number> {
  const r = await db.execute<{ c: number }>(sql`
    select count(*)::int as c from list_views where org_id = ${orgId}`);
  return Number(r.rows[0]?.c ?? 0);
}

async function defaultNames(orgId: string): Promise<string[]> {
  const r = await db.execute<{ name: string }>(sql`
    select name from list_views where org_id = ${orgId} and is_default order by name`);
  return r.rows.map((row) => row.name);
}

test(
  "POST refuses a non-boolean isDefault with a 400 and does not steal the org default",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const prior = await POST(
      postRequest({
        recordType: "vendor_bill",
        name: "Prior default",
        scope: "org",
        config: defaultListView("vendor_bill"),
        isDefault: true,
      }),
    );
    assert.equal(prior.status, 200);
    const res = await POST(
      postRequest({
        recordType: "vendor_bill",
        name: "Thief",
        scope: "org",
        config: defaultListView("vendor_bill"),
        isDefault: "false",
      }),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "isDefault must be a boolean");
    assert.equal(await viewCount(f.orgId), 1, "rejected create must store no row");
    assert.deepEqual(await defaultNames(f.orgId), ["Prior default"]);
  },
);

test(
  "POST still accepts an omitted or real-boolean isDefault",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const implicit = await POST(
      postRequest({
        recordType: "vendor_bill",
        name: "Implicit default flag",
        scope: "org",
        config: defaultListView("vendor_bill"),
      }),
    );
    assert.equal(implicit.status, 200);
    const explicitFalse = await POST(
      postRequest({
        recordType: "vendor_bill",
        name: "Explicit nondefault",
        scope: "org",
        config: defaultListView("vendor_bill"),
        isDefault: false,
      }),
    );
    assert.equal(explicitFalse.status, 200);
    const explicitTrue = await POST(
      postRequest({
        recordType: "vendor_bill",
        name: "Explicit default",
        scope: "org",
        config: defaultListView("vendor_bill"),
        isDefault: true,
      }),
    );
    assert.equal(explicitTrue.status, 200);
    assert.equal(await viewCount(f.orgId), 3);
    assert.deepEqual(await defaultNames(f.orgId), ["Explicit default"]);
  },
);
