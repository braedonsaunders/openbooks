import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Geofences belong to their project's legal entity. A caller restricted to
 * one subsidiary must not enumerate, create, move onto, edit, or delete
 * another subsidiary's fences — every one of those paths answers the
 * uniform 404, so probing ids never oracles what another entity holds.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = {
  orgId: "",
  actorId: "",
  allowedSubsidiaryIds: null as ReadonlySet<string> | null,
};
Object.assign(globalThis, { __geofenceScopeState: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation")
      return virtual("export function redirect() {}; export function notFound() {}");
    if (specifier === "next/headers")
      return virtual("export function cookies() { throw new Error('no cookies in route test') }");
    if (specifier.endsWith("/lib/feature-gates"))
      return virtual(`
        export async function guardFeaturePermission() {
          const s = globalThis.__geofenceScopeState;
          return {
            user: { orgId: s.orgId, id: s.actorId },
            permissions: new Set(['time.manage']),
            allowedSubsidiaryIds: s.allowedSubsidiaryIds,
          };
        }
      `);
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { GET, POST } = await import("./route.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

const CIRCLE = {
  kind: "circle",
  center: { lat: 43.65, lng: -79.38 },
  radiusM: 500,
};

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = randomUUID();
  state.orgId = org.orgId;
  state.actorId = actorId;
  const branchId = randomUUID();
  const projectA = randomUUID();
  const projectB = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Division B', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
    values (${projectA}, ${org.orgId}, ${org.subsidiaryId}, 'GEO-A', 'Geo project A', ${org.customerId}, 'active', true, '{}'::jsonb),
           (${projectB}, ${org.orgId}, ${branchId}, 'GEO-B', 'Geo project B', ${org.customerId}, 'active', true, '{}'::jsonb)`));
  const fenceA = randomUUID();
  const fenceB = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into project_geofences (id, org_id, project_id, kind, center, radius_m, is_active, created_by, updated_by)
    values (${fenceA}, ${org.orgId}, ${projectA}, 'circle', '{"lat":43.65,"lng":-79.38}'::jsonb, 500, true, ${actorId}, ${actorId}),
           (${fenceB}, ${org.orgId}, ${projectB}, 'circle', '{"lat":45.5,"lng":-73.57}'::jsonb, 500, true, ${actorId}, ${actorId})`));
  return { org, branchId, projectA, projectB, fenceA, fenceB };
}

const get = (query = "") =>
  withOrgContext(state.orgId, () =>
    GET(new Request(`http://geofence.test/api/time/geofences${query}`)),
  );

const post = (body: unknown) =>
  withOrgContext(state.orgId, () =>
    POST(
      new Request("http://geofence.test/api/time/geofences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );

async function fenceCount(orgId: string): Promise<number> {
  const rows = (
    await withBypassContext(() =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from project_geofences where org_id = ${orgId}`),
    )
  ).rows;
  return rows[0]!.n;
}

async function fenceProject(orgId: string, id: string): Promise<string | null> {
  const rows = (
    await withBypassContext(() =>
      db.execute<{ project_id: string }>(
        sql`select project_id from project_geofences where org_id = ${orgId} and id = ${id}`,
      ),
    )
  ).rows;
  return rows[0]?.project_id ?? null;
}

test("GET hides another subsidiary's fences from a restricted caller", { skip: !DB }, async () => {
  const { org, projectB } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await get();
    assert.equal(response.status, 200);
    const { geofences } = (await response.json()) as { geofences: { projectId: string }[] };
    assert.equal(geofences.length, 1, "only the caller's own fence is enumerated");
    assert.notEqual(geofences[0]!.projectId, projectB);
    const filtered = await get(`?projectId=${projectB}`);
    assert.equal(filtered.status, 200);
    assert.deepEqual(((await filtered.json()) as { geofences: unknown[] }).geofences, []);
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("save cannot create a fence on another subsidiary's project", { skip: !DB }, async () => {
  const { org, projectB } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const before = await fenceCount(org.orgId);
    const response = await post({ ...CIRCLE, projectId: projectB });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not found" });
    assert.equal(await fenceCount(org.orgId), before, "a refused save writes nothing");
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("save cannot edit another subsidiary's fence or point at its project", { skip: !DB }, async () => {
  const { org, projectA, projectB, fenceA, fenceB } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    // Editing B's fence by id reads as not-found.
    const editHidden = await post({ id: fenceB, ...CIRCLE, projectId: projectB });
    assert.equal(editHidden.status, 404);
    assert.deepEqual(await editHidden.json(), { error: "not found" });
    // Declaring B's project on A's fence reads as not-found too.
    const moveAway = await post({ id: fenceA, ...CIRCLE, projectId: projectB });
    assert.equal(moveAway.status, 404);
    assert.deepEqual(await moveAway.json(), { error: "not found" });
    assert.equal(await fenceProject(org.orgId, fenceA), projectA, "a refused edit changes nothing");
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("delete cannot retire another subsidiary's fence", { skip: !DB }, async () => {
  const { org, fenceB } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await post({ action: "delete", id: fenceB });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not found" });
    assert.notEqual(await fenceProject(org.orgId, fenceB), null, "a refused delete removes nothing");
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an unrestricted caller keeps the full surface", { skip: !DB }, async () => {
  const { org, projectA, fenceA } = await fixture();
  try {
    state.allowedSubsidiaryIds = null;
    const listed = (await (await get()).json()) as { geofences: unknown[] };
    assert.equal(listed.geofences.length, 2);
    const created = await post({ ...CIRCLE, projectId: projectA, kind: "polygon", center: null, radiusM: null, polygon: [{ lat: 0, lng: 0 }, { lat: 1, lng: 0 }, { lat: 0, lng: 1 }] });
    assert.equal(created.status, 200, JSON.stringify(await created.json().catch(() => null)));
    const edited = await post({ id: fenceA, ...CIRCLE, projectId: projectA, radiusM: 750 });
    assert.equal(edited.status, 200);
    const deleted = await post({ action: "delete", id: fenceA });
    assert.equal(deleted.status, 200);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
