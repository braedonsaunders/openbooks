import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// A8 driver-values API: gates, overlap guard, end-dating, onDate reads.
// Same mock-authz harness as the drivers route test.

const stateKey = Symbol.for("openbooks.alloc-values-route-test");
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

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.alloc-values-route-test')]
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
      return { url: "mock:values-authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:values-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const collectionUrl = "./route.ts?alloc-values";
const itemUrl = "./[id]/route.ts?alloc-values";
const collectionRoute = (await import(collectionUrl)) as typeof import("./route.ts");
const itemRoute = (await import(itemUrl)) as typeof import("./[id]/route.ts");
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

interface Setup {
  orgId: string;
  subsidiaryId: string;
  driverId: string;
}

async function setup(): Promise<Setup> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,allocations}', 'true'::jsonb, true)
     where id = ${org.orgId}`);
  const driverId = randomUUID();
  await db.execute(sql`
    insert into allocation_drivers (id, org_id, key, name, dimension, source_kind, created_by, updated_by)
    values (${driverId}, ${org.orgId}, 'values-driver', 'Values driver', 'subsidiary', 'manual', ${actorId}, ${actorId})`);
  authenticate(org.orgId, actorId, ["allocations.read", "allocations.manage"]);
  return { orgId: org.orgId, subsidiaryId: org.subsidiaryId, driverId };
}

function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("values grid: add, overlap refused, end-date, onDate read, delete", { skip: !DB }, async () => {
  const s = await setup();
  try {
    const base = {
      driverId: s.driverId,
      dimensionValueId: s.subsidiaryId,
      effectiveFrom: "2026-01-01",
    };
    const created = await collectionRoute.POST(
      jsonRequest("/api/allocations/driver-values", "POST", { ...base, value: "2.5" }),
    );
    assert.equal(created.status, 201);
    const valueId = ((await created.json()) as { value: { id: string; value: string } }).value.id;

    const overlap = await collectionRoute.POST(
      jsonRequest("/api/allocations/driver-values", "POST", { ...base, effectiveFrom: "2026-03-01", value: "1" }),
    );
    assert.equal(overlap.status, 409);

    const badDecimal = await collectionRoute.POST(
      jsonRequest("/api/allocations/driver-values", "POST", { ...base, effectiveFrom: "2027-01-01", value: "1.23456" }),
    );
    assert.equal(badDecimal.status, 400);

    const ended = await itemRoute.PATCH(
      jsonRequest(`/api/allocations/driver-values/${valueId}`, "PATCH", { effectiveTo: "2026-06-30" }),
      { params: Promise.resolve({ id: valueId }) },
    );
    assert.equal(ended.status, 200);

    const second = await collectionRoute.POST(
      jsonRequest("/api/allocations/driver-values", "POST", { ...base, effectiveFrom: "2026-07-01", value: "4" }),
    );
    assert.equal(second.status, 201);

    const spring = await collectionRoute.GET(
      jsonRequest(`/api/allocations/driver-values?driverId=${s.driverId}&onDate=2026-04-01`, "GET"),
    );
    assert.equal(spring.status, 200);
    assert.deepEqual(
      ((await spring.json()) as { values: { value: string }[] }).values.map((v) => v.value),
      ["2.5000"],
    );
    const autumn = await collectionRoute.GET(
      jsonRequest(`/api/allocations/driver-values?driverId=${s.driverId}&onDate=2026-09-01`, "GET"),
    );
    assert.deepEqual(
      ((await autumn.json()) as { values: { value: string }[] }).values.map((v) => v.value),
      ["4.0000"],
    );

    const malformed = await itemRoute.DELETE(jsonRequest("/api/allocations/driver-values/nope", "DELETE"), {
      params: Promise.resolve({ id: "nope" }),
    });
    assert.equal(malformed.status, 404);

    const deleted = await itemRoute.DELETE(jsonRequest(`/api/allocations/driver-values/${valueId}`, "DELETE"), {
      params: Promise.resolve({ id: valueId }),
    });
    assert.equal(deleted.status, 200);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(s.orgId);
  }
});

test("values writes need manage; reads 404 with feature off", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    authenticate(org.orgId, actorId, ["allocations.read"]);
    const denied = await collectionRoute.POST(jsonRequest("/api/allocations/driver-values", "POST", {}));
    assert.equal(denied.status, 403);
    // Feature off (never enabled for this org).
    const missing = await collectionRoute.GET(
      jsonRequest(`/api/allocations/driver-values?driverId=${randomUUID()}`, "GET"),
    );
    assert.equal(missing.status, 404);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});
