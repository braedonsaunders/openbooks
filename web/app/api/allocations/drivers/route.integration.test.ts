import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// A8 drivers API: permission + feature gates, CRUD, revision tokens,
// preview vector. Authz is mocked at the allocations-gate boundary; the
// feature gate and all SQL stay real (scratch org per test).

const stateKey = Symbol.for("openbooks.alloc-drivers-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
  NextResponse: typeof import("next/server").NextResponse | null;
}
const routeState: RouteState = { authz: null, NextResponse: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

// Mock modules cannot import (tsx resolves the importer's package scope
// against the mock: URL and crashes), so NextResponse arrives via globals,
// stashed by the test file before the routes load.
const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.alloc-drivers-route-test')]
  const { NextResponse } = state
  export async function guardPermission(permission) {
    if (!state.authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const perms = state.authz.permissions
    const covered = perms.has(permission) || perms.has('*') ||
      [...perms].some((p) => p.endsWith('.*') && permission.startsWith(p.slice(0, -1)))
    if (!covered) return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 })
    return state.authz
  }
`;

routeState.NextResponse = (await import("next/server")).NextResponse;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "./authz" && String(context.parentURL ?? "").includes("lib/allocations-gate.ts")) {
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

const listUrl = "./route.ts?alloc-drivers";
const itemUrl = "./[id]/route.ts?alloc-drivers";
const previewUrl = "./preview/route.ts?alloc-drivers";
const listRoute = (await import(listUrl)) as typeof import("./route.ts");
const itemRoute = (await import(itemUrl)) as typeof import("./[id]/route.ts");
const previewRoute = (await import(previewUrl)) as typeof import("./preview/route.ts");
hooks.deregister();

const { db } = await import("../../../../../engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "../../../../../engine/src/test-fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

function authenticate(orgId: string, actorId: string, permissions: string[]): void {
  routeState.authz = {
    user: { orgId, id: actorId },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  };
}

async function enableAllocations(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,allocations}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const READ = ["allocations.read"];
const MANAGE = ["allocations.manage"];

test("drivers API is gated: 401 without session, 403 without permission, 404 with feature off", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    routeState.authz = null;
    assert.equal((await listRoute.GET(jsonRequest("/api/allocations/drivers", "GET"))).status, 401);

    authenticate(org.orgId, actorId, READ);
    // Feature still off: reads 404 like a missing route.
    assert.equal((await listRoute.GET(jsonRequest("/api/allocations/drivers", "GET"))).status, 404);

    await enableAllocations(org.orgId);
    assert.equal((await listRoute.GET(jsonRequest("/api/allocations/drivers", "GET"))).status, 200);
    // Writes need manage.
    const denied = await listRoute.POST(jsonRequest("/api/allocations/drivers", "POST", { key: "x", name: "X", dimension: "department", sourceKind: "manual" }));
    assert.equal(denied.status, 403);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});

test("drivers CRUD round trip with revision token", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await enableAllocations(org.orgId);
    authenticate(org.orgId, actorId, [...READ, ...MANAGE]);

    const created = await listRoute.POST(jsonRequest("/api/allocations/drivers", "POST", {
      key: "route-driver",
      name: "Route driver",
      dimension: "department",
      sourceKind: "manual",
    }));
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { driver: { id: string; key: string; updatedAt: string } };
    const id = createdBody.driver.id;

    const bad = await listRoute.POST(jsonRequest("/api/allocations/drivers", "POST", {
      key: "BAD KEY",
      name: "Bad",
      dimension: "department",
      sourceKind: "manual",
    }));
    assert.equal(bad.status, 400);

    const listed = await listRoute.GET(jsonRequest("/api/allocations/drivers", "GET"));
    assert.equal(listed.status, 200);
    assert.ok(((await listed.json()) as { drivers: { id: string }[] }).drivers.some((d) => d.id === id));

    const got = await itemRoute.GET(jsonRequest(`/api/allocations/drivers/${id}`, "GET"), {
      params: Promise.resolve({ id }),
    });
    assert.equal(got.status, 200);

    const malformed = await itemRoute.GET(jsonRequest("/api/allocations/drivers/new", "GET"), {
      params: Promise.resolve({ id: "new" }),
    });
    assert.equal(malformed.status, 404);

    const patched = await itemRoute.PATCH(
      jsonRequest(`/api/allocations/drivers/${id}`, "PATCH", {
        name: "Renamed",
        expectedUpdatedAt: createdBody.driver.updatedAt,
      }),
      { params: Promise.resolve({ id }) },
    );
    assert.equal(patched.status, 200);
    assert.equal(((await patched.json()) as { driver: { name: string } }).driver.name, "Renamed");

    const stale = await itemRoute.PATCH(
      jsonRequest(`/api/allocations/drivers/${id}`, "PATCH", {
        name: "Stale",
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      }),
      { params: Promise.resolve({ id }) },
    );
    assert.equal(stale.status, 412);

    const deleted = await itemRoute.DELETE(jsonRequest(`/api/allocations/drivers/${id}`, "DELETE"), {
      params: Promise.resolve({ id }),
    });
    assert.equal(deleted.status, 200);
    const gone = await itemRoute.GET(jsonRequest(`/api/allocations/drivers/${id}`, "GET"), {
      params: Promise.resolve({ id }),
    });
    assert.equal(gone.status, 404);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});

test("driver preview returns exact shares; empty drivers report why", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await enableAllocations(org.orgId);
    authenticate(org.orgId, actorId, [...READ, ...MANAGE]);

    const created = await listRoute.POST(jsonRequest("/api/allocations/drivers", "POST", {
      key: "preview-driver",
      name: "Preview driver",
      dimension: "subsidiary",
      sourceKind: "manual",
    }));
    const driverId = ((await created.json()) as { driver: { id: string } }).driver.id;
    await db.execute(sql`
      insert into allocation_driver_values
        (org_id, driver_id, dimension_value_id, effective_from, value, created_by, updated_by)
      values
        (${org.orgId}, ${driverId}, ${org.subsidiaryId}, '2026-01-01', '3.0000', ${actorId}, ${actorId})`);

    const preview = await previewRoute.POST(jsonRequest("/api/allocations/drivers/preview", "POST", {
      driverId,
      date: "2026-05-01",
    }));
    assert.equal(preview.status, 200);
    const body = (await preview.json()) as {
      date: string;
      rows: { id: string; label: string; value: string; share: string }[];
    };
    assert.equal(body.date, "2026-05-01");
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0]?.value, "3.0000");
    assert.equal(body.rows[0]?.share, "1.0000");
    assert.ok((body.rows[0]?.label ?? "").length > 0);

    const both = await previewRoute.POST(jsonRequest("/api/allocations/drivers/preview", "POST", {
      driverId,
      date: "2026-05-01",
      periodId: org.periodId,
    }));
    assert.equal(both.status, 400);

    const gl = await listRoute.POST(jsonRequest("/api/allocations/drivers", "POST", {
      key: "preview-gl",
      name: "Preview GL",
      dimension: "department",
      sourceKind: "gl_activity",
      config: { accountScope: { kind: "any" } },
    }));
    const glId = ((await gl.json()) as { driver: { id: string } }).driver.id;
    // A2 resolves for real now. A date as-of with no posted lines yields
    // an empty vector (nothing to weight — shown as "no weights", never
    // zeros); the period fast path reports why it cannot compute.
    const empty = await previewRoute.POST(jsonRequest("/api/allocations/drivers/preview", "POST", {
      driverId: glId,
      date: "2026-05-01",
    }));
    assert.equal(empty.status, 200);
    assert.deepEqual(((await empty.json()) as { rows: unknown[] }).rows, []);
    // A native measure with no data source for the dimension explains
    // itself — 422 with the reason, never a guessed vector.
    const native = await listRoute.POST(jsonRequest("/api/allocations/drivers", "POST", {
      key: "preview-native",
      name: "Preview native",
      dimension: "class",
      sourceKind: "native_measure",
      config: { measure: "headcount" },
    }));
    const nativeId = ((await native.json()) as { driver: { id: string } }).driver.id;
    const unavailable = await previewRoute.POST(jsonRequest("/api/allocations/drivers/preview", "POST", {
      driverId: nativeId,
      date: "2026-05-01",
    }));
    assert.equal(unavailable.status, 422);
    assert.match(((await unavailable.json()) as { error: string }).error, /no data source/);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});
