import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// A8 options endpoint: one picker payload, gated, subsidiary-scoped.

const stateKey = Symbol.for("openbooks.alloc-options-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: string[] | null;
  } | null;
  NextResponse: typeof import("next/server").NextResponse | null;
}
const routeState: RouteState = { authz: null, NextResponse: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.alloc-options-route-test')]
  const { NextResponse } = state
  export async function guardPermission(permission) {
    if (!state.authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    if (!state.authz.permissions.has(permission)) {
      return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 })
    }
    if (state.authz.allowedSubsidiaryIds === null) return { ...state.authz, allowedSubsidiaryIds: null }
    return { ...state.authz, allowedSubsidiaryIds: new Set(state.authz.allowedSubsidiaryIds) }
  }
`;

routeState.NextResponse = (await import("next/server")).NextResponse;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "./authz" && String(context.parentURL ?? "").includes("lib/allocations-gate.ts")) {
      return { url: "mock:options-authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:options-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?alloc-options";
const optionsRoute = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("../../../../../engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "../../../../../engine/src/testing/fixtures.ts"
);
import { sql } from "drizzle-orm";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("options returns every picker list; subsidiaries follow scope", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,allocations}', 'true'::jsonb, true)
       where id = ${org.orgId}`);
    routeState.authz = {
      user: { orgId: org.orgId, id: actorId },
      permissions: new Set(["allocations.read"]),
      allowedSubsidiaryIds: null,
    };
    await db.execute(sql`
      insert into vendor_roles (org_id, party_id, is_active)
      values (${org.orgId}, ${org.vendorId}, true)`);
    await db.execute(sql`
      insert into customer_roles (org_id, party_id, is_active)
      values (${org.orgId}, ${org.customerId}, true)`);
    const segmentId = randomUUID();
    await db.execute(sql`
      insert into segment_definitions (id, org_id, key, name, plural_name, source_kind, is_active)
      values (${segmentId}, ${org.orgId}, 'region', 'Region', 'Regions', 'custom', true)`);
    const regionEast = randomUUID();
    const regionWest = randomUUID();
    await db.execute(sql`
      insert into segment_values (id, org_id, segment_id, code, name, is_active)
      values (${regionEast}, ${org.orgId}, ${segmentId}, 'E', 'East', true),
             (${regionWest}, ${org.orgId}, ${segmentId}, 'W', 'West', false)`);
    const res = await optionsRoute.GET();
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, { id: string }[]>;
    for (const key of ["accounts", "departments", "locations", "classes", "projects", "subsidiaries", "books", "periods", "rules", "reports", "measures", "parties", "items", "segments"]) {
      assert.ok(Array.isArray(body[key]), key);
    }
    assert.ok((body.accounts ?? []).length > 0, "seeded chart");
    assert.ok((body.periods ?? []).length > 0, "seeded periods");
    assert.ok((body.books ?? []).some((b) => b.id === org.bookId), "primary book listed");
    assert.ok((body.subsidiaries ?? []).some((s) => s.id === org.subsidiaryId), "root subsidiary listed");
    assert.ok((body.measures ?? []).some((m) => m.id === "headcount"), "native measures listed");
    const parties = (body.parties ?? []) as { id: string; label: string; roles: string[] }[];
    const vendor = parties.find((p) => p.id === org.vendorId);
    assert.ok(vendor, "seeded vendor listed");
    assert.ok(vendor.roles.includes("vendor"), "vendor role served from the role table");
    const customer = parties.find((p) => p.id === org.customerId);
    assert.ok(customer, "seeded customer listed");
    assert.ok(customer.roles.includes("customer"), "customer role served from the role table");
    assert.ok(!customer.roles.includes("vendor"), "roles are per-party");
    const items = (body.items ?? []) as { id: string; label: string }[];
    assert.ok(items.some((i) => i.label === "FIFO Widget"), "seeded items listed");
    const segments = (body.segments ?? []) as unknown as { key: string; label: string; values: { id: string; label: string }[] }[];
    const region = segments.find((s) => s.key === "region");
    assert.ok(region, "custom segment listed");
    assert.equal(region.label, "Regions");
    assert.ok(region.values.some((v) => v.id === regionEast), "active segment value listed");
    assert.ok(!region.values.some((v) => v.id === regionWest), "inactive segment value excluded");

    routeState.authz = {
      user: { orgId: org.orgId, id: actorId },
      permissions: new Set(["allocations.read"]),
      allowedSubsidiaryIds: [],
    };
    const scoped = (await (await optionsRoute.GET()).json()) as {
      subsidiaries: unknown[];
      parties: unknown[];
      items: { id: string }[];
      segments: unknown[];
    };
    assert.deepEqual(scoped.subsidiaries, []);
    assert.deepEqual(scoped.parties, [], "empty scope discloses no parties");
    assert.deepEqual(scoped.segments, [], "empty scope discloses no segment values");
    assert.ok(scoped.items.length > 0, "items are organization-wide");
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});
