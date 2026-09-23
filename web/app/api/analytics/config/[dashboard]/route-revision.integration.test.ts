import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression for /api/analytics/config/[dashboard] revision
// fencing. Two admins editing different thresholds from the same loaded
// version used to whole-object overwrite each other: the later PUT silently
// restored the first admin's threshold to its stale value. PUT now requires
// the exact revision from the last read; a stale token is a 409 carrying the
// current values.

const stateKey = Symbol.for("openbooks.analytics-config-revision-integration");
interface RouteState {
  authz: { user: { orgId: string; id: string } } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.analytics-config-revision-integration')]
  export async function guardPermission() {
    return state.authz
  }
`;

const mockFeatures = `
  export async function isFeatureEnabled() {
    return true
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
    if (
      specifier === "../../../../../lib/authz" &&
      (context.parentURL?.includes("analytics/config/[dashboard]/route") === true ||
        context.parentURL?.includes("analytics/config/%5Bdashboard%5D/route") === true)
    ) {
      return { url: "mock:analytics-config-authz", shortCircuit: true };
    }
    if (
      specifier === "../../../../../lib/features" &&
      (context.parentURL?.includes("analytics/config/[dashboard]/route") === true ||
        context.parentURL?.includes("analytics/config/%5Bdashboard%5D/route") === true)
    ) {
      return { url: "mock:analytics-config-features", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:analytics-config-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    if (url === "mock:analytics-config-features") {
      return { format: "module", source: mockFeatures, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?analytics-config-revision-integration";
const { GET, PUT } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const DASHBOARD = "sentinel";
const DEFAULTS = {
  duplicateDays: 14,
  duplicateMinAmount: 100,
  sequentialMinCount: 3,
  sequentialMinDays: 7,
};

async function seed(): Promise<{ orgId: string; actorId: string }> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Config Admin", "admin");
  routeState.authz = { user: { orgId: org.orgId, id: actorId } };
  return { orgId: org.orgId, actorId };
}

function params(dashboard: string = DASHBOARD): { params: Promise<{ dashboard: string }> } {
  return { params: Promise.resolve({ dashboard }) };
}

function putRequest(body: unknown, dashboard: string = DASHBOARD): Request {
  return new Request(`http://localhost/api/analytics/config/${dashboard}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(): Request {
  return new Request(`http://localhost/api/analytics/config/${DASHBOARD}`, { method: "GET" });
}

async function storedSettings(
  orgId: string,
  dashboard: string = DASHBOARD,
): Promise<{ values: unknown; revision: number }> {
  const r = await db.execute<{ values: unknown; revision: number }>(sql`
    select settings -> 'analytics' -> ${dashboard} as values,
           coalesce((settings -> 'analytics' ->> ${`${dashboard}Revision`})::int, 0) as revision
      from orgs where id = ${orgId}
  `);
  return { values: r.rows[0]?.values ?? null, revision: Number(r.rows[0]?.revision ?? 0) };
}

test(
  "GET exposes the revision alongside the effective values",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    await seed();
    const res = await GET(getRequest(), params());
    assert.equal(res.status, 200);
    const body = (await res.json()) as { values: unknown; revision: unknown };
    assert.deepEqual(body.values, DEFAULTS);
    assert.equal(body.revision, 0);
  },
);

test(
  "concurrent edits from one base: the second 409s and nothing is lost",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();

    // Admin A changes the duplicate window and commits from revision 0.
    const adminA = await PUT(
      putRequest({ expectedRevision: 0, values: { ...DEFAULTS, duplicateDays: 21 } }),
      params(),
    );
    assert.equal(adminA.status, 200);
    assert.equal(((await adminA.json()) as { revision: number }).revision, 1);

    // Admin B edited a different threshold from the same base version. Its
    // whole-object write must not restore A's threshold to the stale value.
    const adminB = await PUT(
      putRequest({ expectedRevision: 0, values: { ...DEFAULTS, duplicateMinAmount: 250 } }),
      params(),
    );
    assert.equal(adminB.status, 409);
    const conflict = (await adminB.json()) as {
      error: string;
      revision: number;
      values: Record<string, number>;
    };
    assert.match(conflict.error, /changed after you opened it/);
    assert.equal(conflict.revision, 1);
    assert.equal(conflict.values.duplicateDays, 21);

    // Nothing is lost: the stored row still holds A's committed change.
    assert.deepEqual((await storedSettings(f.orgId)).values, { ...DEFAULTS, duplicateDays: 21 });

    // B reapplies onto the live revision and commits.
    const retry = await PUT(
      putRequest({
        expectedRevision: conflict.revision,
        values: { ...conflict.values, duplicateMinAmount: 250 },
      }),
      params(),
    );
    assert.equal(retry.status, 200);
    assert.equal(((await retry.json()) as { revision: number }).revision, 2);
    assert.deepEqual((await storedSettings(f.orgId)).values, {
      ...DEFAULTS,
      duplicateDays: 21,
      duplicateMinAmount: 250,
    });
  },
);

test(
  "a missing revision is a 409 naming the remedy, never a blind overwrite",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await PUT(putRequest({ values: DEFAULTS }), params());
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /revision is required/);
    assert.equal((await storedSettings(f.orgId)).revision, 0);
  },
);
