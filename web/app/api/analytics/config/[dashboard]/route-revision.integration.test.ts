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
  "a successful update writes one audit row with actor, before, and after",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await PUT(
      putRequest({ expectedRevision: 0, values: { ...DEFAULTS, duplicateDays: 21 } }),
      params(),
    );
    assert.equal(res.status, 200);

    const audits = await db.execute<{
      actor: string;
      action: string;
      changes: {
        before: { analytics: Record<string, unknown> };
        after: { analytics: Record<string, unknown> };
      };
    }>(sql`
      select actor_id as actor, action, changes from audit_log
       where org_id = ${f.orgId} and table_name = 'orgs' and row_id = ${f.orgId}
       order by id desc limit 5
    `);
    assert.equal(audits.rows.length, 1, "exactly one audit row covers the update");
    const audit = audits.rows[0]!;
    assert.equal(audit.actor, f.actorId);
    assert.equal(audit.action, "update");
    assert.deepEqual(audit.changes.before.analytics[DASHBOARD], {});
    assert.equal(audit.changes.before.analytics[`${DASHBOARD}Revision`], 0);
    assert.deepEqual(audit.changes.after.analytics[DASHBOARD], { ...DEFAULTS, duplicateDays: 21 });
    assert.equal(audit.changes.after.analytics[`${DASHBOARD}Revision`], 1);
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

const UTILIZATION = "utilization";
const UTILIZATION_DEFAULTS = { targetBillablePct: 70, costSpikeThreshold: 1000, minHours: 10 };

test(
  "a non-numeric threshold is a named 422 with nothing saved",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await PUT(
      putRequest(
        { expectedRevision: 0, values: { ...UTILIZATION_DEFAULTS, costSpikeThreshold: "bad" } },
        UTILIZATION,
      ),
      params(UTILIZATION),
    );
    assert.equal(res.status, 422);
    assert.match(((await res.json()) as { error: string }).error, /costSpikeThreshold/);
    assert.deepEqual(await storedSettings(f.orgId, UTILIZATION), { values: null, revision: 0 });
  },
);

test(
  "an out-of-range threshold is a named 422 with nothing saved",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await PUT(
      putRequest(
        { expectedRevision: 0, values: { ...UTILIZATION_DEFAULTS, targetBillablePct: 999 } },
        UTILIZATION,
      ),
      params(UTILIZATION),
    );
    assert.equal(res.status, 422);
    const error = ((await res.json()) as { error: string }).error;
    assert.match(error, /targetBillablePct/);
    assert.match(error, /between 10 and 100/);
    assert.deepEqual(await storedSettings(f.orgId, UTILIZATION), { values: null, revision: 0 });
  },
);

test(
  "unknown and missing thresholds are named 422s with nothing saved",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const unknown = await PUT(
      putRequest(
        { expectedRevision: 0, values: { ...UTILIZATION_DEFAULTS, bonusRate: 5 } },
        UTILIZATION,
      ),
      params(UTILIZATION),
    );
    assert.equal(unknown.status, 422);
    assert.match(((await unknown.json()) as { error: string }).error, /unknown threshold 'bonusRate'/);

    const { minHours: _dropped, ...partial } = UTILIZATION_DEFAULTS;
    const missing = await PUT(
      putRequest({ expectedRevision: 0, values: partial }, UTILIZATION),
      params(UTILIZATION),
    );
    assert.equal(missing.status, 422);
    assert.match(((await missing.json()) as { error: string }).error, /minHours/);
    assert.deepEqual(await storedSettings(f.orgId, UTILIZATION), { values: null, revision: 0 });
  },
);

test(
  "ledger-money thresholds validate exactly: bad cap and bad flag refuse, a good cap normalizes",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const badCap = await PUT(
      putRequest(
        { expectedRevision: 0, values: { weeklyApCap: "bad", restrictToSafe: 0 } },
        "cashflow",
      ),
      params("cashflow"),
    );
    assert.equal(badCap.status, 422);
    assert.match(((await badCap.json()) as { error: string }).error, /weeklyApCap/);

    const badFlag = await PUT(
      putRequest(
        { expectedRevision: 0, values: { weeklyApCap: "0.0000", restrictToSafe: 2 } },
        "cashflow",
      ),
      params("cashflow"),
    );
    assert.equal(badFlag.status, 422);
    assert.match(((await badFlag.json()) as { error: string }).error, /restrictToSafe/);
    assert.deepEqual(await storedSettings(f.orgId, "cashflow"), { values: null, revision: 0 });

    const good = await PUT(
      putRequest(
        { expectedRevision: 0, values: { weeklyApCap: "5000", restrictToSafe: 1 } },
        "cashflow",
      ),
      params("cashflow"),
    );
    assert.equal(good.status, 200);
    assert.deepEqual((await storedSettings(f.orgId, "cashflow")).values, {
      weeklyApCap: "5000.0000",
      restrictToSafe: 1,
    });
  },
);
