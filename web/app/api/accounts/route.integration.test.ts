import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// A bank account flagged reconcilable without a settlement currency violates
// the storage invariant (accounts_reconcilable_currency_required). The
// accounts POST and PATCH routes must refuse that combination as a 422
// request-state failure, not let it reach the database as a raw 500. These
// tests drive the REAL handlers (only the session gate is stubbed).

const stateKey = Symbol.for("openbooks.reconcilable-currency-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.reconcilable-currency-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    // The two routes import the session gate by different relative paths;
    // stub both specifiers at one shared mock URL so they see one state.
    if (
      specifier === "../../../lib/authz" ||
      specifier === "../../../../lib/authz"
    ) {
      return { url: "mock:authz", shortCircuit: true };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      const parentDir = decodeURIComponent(new URL(".", context.parentURL).href);
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts").href, context);
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

const postRouteUrl = "./route.ts?reconcilable-currency-post";
const patchRouteUrl = "./[id]/route.ts?reconcilable-currency-patch";
const { POST } = (await import(postRouteUrl)) as typeof import("./route.ts");
const { PATCH } = (await import(patchRouteUrl)) as typeof import("./[id]/route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/test-fixtures.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

function postRequest(key: string, body: unknown): Request {
  return new Request("http://localhost/api/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

function patchRequest(body: unknown): Request {
  return new Request("http://localhost/api/accounts/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function enableMultiCurrency(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = coalesce(settings, '{}'::jsonb) || '{"features":{"multiCurrency":true}}'::jsonb
     where id = ${orgId}
  `);
}

test(
  "accounts POST refuses a reconcilable account without a currency instead of failing in storage",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { adminId } = await seedFlowActors(org.orgId);
      routeState.authz = { user: { orgId: org.orgId, id: adminId }, permissions: new Set(), allowedSubsidiaryIds: null };
      await enableMultiCurrency(org.orgId);

      const refused = await POST(
        postRequest(randomUUID(), { name: "Settlement cash", type: "asset_bank", reconcilable: true }),
      );
      assert.equal(refused.status, 422);
      assert.deepEqual(await refused.json(), {
        error: "reconcilable_currency_required",
        field: "currencyRestriction",
      });

      const created = await POST(
        postRequest(randomUUID(), {
          name: "Settlement cash",
          type: "asset_bank",
          reconcilable: true,
          currencyRestriction: "CAD",
        }),
      );
      assert.equal(created.status, 201);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "accounts POST/PATCH let the reconcilable base currency through when Multi-currency is off",
  { skip: !DB },
  async () => {
    // F-t05-003: single-currency orgs (scratch orgs are CAD, feature off)
    // have no other currency to settle in, so the reconcilable invariant can
    // only ever mean the base currency. Anything else stays refused.
    const org = await createScratchOrg();
    try {
      const { adminId } = await seedFlowActors(org.orgId);
      routeState.authz = { user: { orgId: org.orgId, id: adminId }, permissions: new Set(), allowedSubsidiaryIds: null };

      const created = await POST(
        postRequest(randomUUID(), {
          name: "Base settlement cash",
          type: "asset_bank",
          reconcilable: true,
          currencyRestriction: "CAD",
        }),
      );
      assert.equal(created.status, 201);

      const foreign = await POST(
        postRequest(randomUUID(), {
          name: "Foreign settlement cash",
          type: "asset_bank",
          reconcilable: true,
          currencyRestriction: "USD",
        }),
      );
      assert.equal(foreign.status, 404);

      const unflagged = await POST(
        postRequest(randomUUID(), {
          name: "Plain cash with currency",
          type: "asset_bank",
          currencyRestriction: "CAD",
        }),
      );
      assert.equal(unflagged.status, 404);

      const plainId = randomUUID();
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type)
        values (${plainId}, ${org.orgId}, '9003', 'Plain cash', 'asset_bank')
      `);
      const allowed = await PATCH(patchRequest({ reconcilable: true, currencyRestriction: "cad" }), {
        params: Promise.resolve({ id: plainId }),
      });
      assert.equal(allowed.status, 200);

      const refused = await PATCH(patchRequest({ reconcilable: true, currencyRestriction: "USD" }), {
        params: Promise.resolve({ id: plainId }),
      });
      assert.equal(refused.status, 404);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "accounts PATCH refuses to add reconcilable or drop its currency instead of failing in storage",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { adminId } = await seedFlowActors(org.orgId);
      routeState.authz = { user: { orgId: org.orgId, id: adminId }, permissions: new Set(), allowedSubsidiaryIds: null };
      await enableMultiCurrency(org.orgId);

      const plainId = randomUUID();
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type)
        values (${plainId}, ${org.orgId}, '9001', 'Plain cash', 'asset_bank')
      `);
      const refused = await PATCH(patchRequest({ reconcilable: true }), {
        params: Promise.resolve({ id: plainId }),
      });
      assert.equal(refused.status, 422);
      assert.deepEqual(await refused.json(), {
        error: "reconcilable_currency_required",
        field: "currencyRestriction",
      });
      const allowed = await PATCH(
        patchRequest({ reconcilable: true, currencyRestriction: "CAD" }),
        { params: Promise.resolve({ id: plainId }) },
      );
      assert.equal(allowed.status, 200);

      const settledId = randomUUID();
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, reconcilable, currency_restriction)
        values (${settledId}, ${org.orgId}, '9002', 'Settled cash', 'asset_bank', true, 'CAD')
      `);
      const cleared = await PATCH(patchRequest({ currencyRestriction: null }), {
        params: Promise.resolve({ id: settledId }),
      });
      assert.equal(cleared.status, 422);
      assert.deepEqual(await cleared.json(), {
        error: "reconcilable_currency_required",
        field: "currencyRestriction",
      });
    } finally {
      routeState.authz = null;
      await dropScratchOrg(org.orgId);
    }
  },
);
