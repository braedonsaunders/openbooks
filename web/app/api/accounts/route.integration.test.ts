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
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const module_ = (source: string): { shortCircuit: true; format: "module"; url: string } => ({
  shortCircuit: true,
  format: "module",
  url: `data:text/javascript,${encodeURIComponent(source)}`,
});

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    // The two routes import the session gate by different relative paths.
    // Re-export the REAL authz module and override only the session gate, so
    // the subsidiary-scope guards under test are the production functions —
    // a hand-copied guard double could only drift from the original.
    if (
      specifier === "../../../lib/authz" ||
      specifier === "../../../../lib/authz"
    ) {
      const real = nextResolve(specifier, context).url;
      const nextServer = nextResolve("next/server", context).url;
      return module_(`
        export * from ${JSON.stringify(real)};
        const state = globalThis[Symbol.for('openbooks.reconcilable-currency-test')];
        const { NextResponse } = await import(${JSON.stringify(nextServer)});
        export async function guardPermission(_permission) {
          if (!state.authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
          return { permissions: new Set(), allowedSubsidiaryIds: null, ...state.authz };
        }
      `);
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      const parentDir = decodeURIComponent(new URL(".", context.parentURL).href);
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts").href, context);
    }
    return nextResolve(specifier, context);
  },
});

const postRouteUrl = "./route.ts?reconcilable-currency-post";
const patchRouteUrl = "./[id]/route.ts?reconcilable-currency-patch";
const { POST } = (await import(postRouteUrl)) as typeof import("./route.ts");
const { PATCH, GET } = (await import(patchRouteUrl)) as typeof import("./[id]/route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");

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

test(
  "accounts routes scope entity-owned accounts to the caller subsidiary",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { adminId } = await seedFlowActors(org.orgId);
      const entityB = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${entityB}, ${org.orgId}, ${org.subsidiaryId}, 'Entity B', 'CAD', 'CA')
      `);
      const seed = async (number: string, subsidiaryId: string | null) =>
        db.execute(sql`
          insert into accounts (id, org_id, number, name, type, subsidiary_id)
          values (${randomUUID()}, ${org.orgId}, ${number}, ${`Scoped ${number}`}, 'asset_other', ${subsidiaryId})
          returning id
        `);
      const accountA = (await seed('9101', org.subsidiaryId)).rows[0]!.id as string;
      const accountB = (await seed('9102', entityB)).rows[0]!.id as string;
      const sharedId = (await seed('9103', null)).rows[0]!.id as string;
      const scoped = (subsidiaryId: string) => {
        routeState.authz = {
          user: { orgId: org.orgId, id: adminId },
          permissions: new Set(),
          allowedSubsidiaryIds: new Set([subsidiaryId]),
        };
      };

      scoped(org.subsidiaryId);
      // Reads: B's metadata is indistinguishable from missing; the shared
      // chart reads for every caller.
      assert.equal((await GET(new Request('http://localhost/'), { params: Promise.resolve({ id: accountB }) })).status, 404);
      assert.equal((await GET(new Request('http://localhost/'), { params: Promise.resolve({ id: accountA }) })).status, 200);
      assert.equal((await GET(new Request('http://localhost/'), { params: Promise.resolve({ id: sharedId }) })).status, 200);
      // Writes: minting B's account or the shared chart refuses, and the
      // refusal stores nothing.
      const mintB = await POST(postRequest(randomUUID(), { name: 'B cash', type: 'asset_other', subsidiaryId: entityB }));
      assert.equal(mintB.status, 404);
      assert.deepEqual(await mintB.json(), { error: 'not found' });
      // The shared chart is visible, so its refusal names the remedy (403)
      // instead of hiding behind the record-level 404.
      const mintShared = await POST(postRequest(randomUUID(), { name: 'Shared cash', type: 'asset_other' }));
      assert.equal(mintShared.status, 403);
      assert.deepEqual(await mintShared.json(), { error: 'requires unrestricted subsidiary access' });
      const mintA = await POST(postRequest(randomUUID(), { name: 'A cash', type: 'asset_other', subsidiaryId: org.subsidiaryId }));
      assert.equal(mintA.status, 201);
      const stored = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from accounts where org_id = ${org.orgId} and name in ('B cash', 'Shared cash')
      `);
      assert.equal(stored.rows[0]?.n ?? -1, 0, 'refused creates store nothing');
      // PATCH: B's account is unreachable, A cannot move to B, and the shared
      // chart refuses a restricted write.
      assert.equal((await PATCH(patchRequest({ name: 'B renamed' }), { params: Promise.resolve({ id: accountB }) })).status, 404);
      assert.equal((await PATCH(patchRequest({ subsidiaryId: entityB }), { params: Promise.resolve({ id: accountA }) })).status, 404);
      const sharedPatch = await PATCH(patchRequest({ name: 'Shared renamed' }), { params: Promise.resolve({ id: sharedId }) });
      assert.equal(sharedPatch.status, 403);
      assert.deepEqual(await sharedPatch.json(), { error: 'requires unrestricted subsidiary access' });
      const renamed = await PATCH(patchRequest({ name: 'A renamed' }), { params: Promise.resolve({ id: accountA }) });
      assert.equal(renamed.status, 200);
      // Control: the unrestricted caller still mints the shared chart.
      routeState.authz = { user: { orgId: org.orgId, id: adminId }, permissions: new Set(), allowedSubsidiaryIds: null };
      assert.equal((await POST(postRequest(randomUUID(), { name: 'Control shared', type: 'asset_other' }))).status, 201);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(org.orgId);
    }
  },
);
