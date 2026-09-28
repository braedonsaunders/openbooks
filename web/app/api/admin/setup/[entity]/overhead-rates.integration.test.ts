import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Single overhead-rates card serving Projects or Manufacturing (MF-07 C7b).
// Every assertion below goes through the real generic Setup route
// (/api/admin/setup/[entity]) or the shared command layer it adapts —
// never a helper in isolation — so a UI-only gate or a drifted copy cannot
// pass. The generic any-of registry/route properties stay owned by C7a:
// this suite proves only the overhead card's own contract.
const stateKey = Symbol.for("openbooks.overhead-rates-integration-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.overhead-rates-integration-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export async function requirePermission(_permission) { return state.authz }
  export function can() { return true }
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next-intl/server") return { shortCircuit: true, format: "module", url: "mock:setup-intl" };
    const entityRoute = context.parentURL?.includes("%5Bentity%5D")
      ?? context.parentURL?.includes("[entity]");
    if (specifier === "../../../../../lib/authz" && entityRoute) {
      return { url: "mock:authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    if (url === "mock:setup-intl") {
      return { format: "module", source: `export async function getTranslations(){ return (key) => key }; export async function getLocale(){ return 'en' }`, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?overhead-rates-integration-test";
const { DELETE, PATCH, POST } = (await import(routeUrl)) as typeof import("./route.ts");
const { SETUP_ENTITY_BY_KEY, SETUP_PROJECTS_OR_MANUFACTURING_REMEDY, resolveSetupEntityGate } = await import(
  "../../../../../lib/setup/registry.ts"
);
const { createSetupRecord, preflightSetupWrite, updateSetupRecord } = await import(
  "../../../../../lib/setup/write.ts"
);
const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;
const FEATURES_REMEDY = "Turn on Projects or Manufacturing in Company Settings → Features.";

function authenticate(orgId: string, actorId: string) {
  routeState.authz = {
    user: { orgId, id: actorId },
    permissions: new Set(["admin.setup.manage"]),
    allowedSubsidiaryIds: null,
  };
}
function directActor(orgId: string, actorId: string) {
  return { orgId, id: actorId, permissions: new Set(["admin.setup.manage"]), allowedSubsidiaryIds: null };
}
function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/setup/overhead-rates", {
    method: "POST",
    headers: { "Idempotency-Key": randomUUID() },
    body: JSON.stringify(body),
  });
}
function patchRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/setup/overhead-rates", { method: "PATCH", body: JSON.stringify(body) });
}
function deleteRequest(id: string): Request {
  return new Request(`http://localhost/api/admin/setup/overhead-rates?id=${id}`, { method: "DELETE" });
}
const call = () => ({ params: Promise.resolve({ entity: "overhead-rates" }) });

async function setFeatures(orgId: string, features: Record<string, boolean>) {
  await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(features)}::jsonb, true) where id = ${orgId}`);
}

async function readRate(orgId: string, id: string): Promise<Record<string, unknown>> {
  const rows = (await db.execute(sql`
    select id, category, method, rate_kind as "rateKind", rate_percent::text as "ratePercent",
           effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
           created_by as "createdBy", updated_by as "updatedBy"
      from overhead_rates where id = ${id} and org_id = ${orgId}`)).rows as Record<string, unknown>[];
  assert.ok(rows[0], "the refused-or-created rate must be readable back from storage");
  return rows[0]!;
}

async function countRates(orgId: string): Promise<number> {
  return Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from overhead_rates where org_id = ${orgId}`)).rows[0]!.n);
}

test("manufacturing-only admits standard basis cards and refuses project cards by name", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Overhead Mfg Admin", "admin");
  try {
    authenticate(org.orgId, actorId);
    await setFeatures(org.orgId, { projects: false, manufacturing: true, inventory: true });
    // The shared drawer path admits: preflight passes and a basis write stores.
    assert.equal(await preflightSetupWrite(directActor(org.orgId, actorId), "overhead-rates", "create"), null);
    const standard = await POST(postRequest({
      category: "Shop supplies", method: "standard", rateKind: "per_hour", ratePercent: "12.5", effectiveFrom: "2026-01-01",
    }), call());
    assert.equal(standard.status, 200);
    for (const rateKind of ["per_machine_hour", "per_unit"]) {
      const created = await POST(postRequest({
        method: "standard", rateKind, ratePercent: "8", effectiveFrom: "2026-01-01",
      }), call());
      assert.equal(created.status, 200, `manufacturing basis ${rateKind} must store`);
    }
    // Project-only methods refuse by name with the Features remedy.
    for (const [method, name] of [["live", "Live"], ["three_year_average", "Three-year average"]] as const) {
      const refused = await POST(postRequest({
        method, rateKind: "per_hour", ratePercent: "10", effectiveFrom: "2026-02-01",
      }), call());
      assert.equal(refused.status, 400);
      const body = (await refused.json()) as { error: string; code: string };
      assert.equal(body.code, "invalid");
      assert.match(body.error, new RegExp(name));
      assert.match(body.error, /Standard/);
      assert.match(body.error, /Company Settings → Features/);
    }
    // An omitted method falls through to the storage default (live), which has
    // no manufacturing basis — fail closed rather than store an unnamed card.
    const omitted = await POST(postRequest({ rateKind: "per_hour", ratePercent: "10", effectiveFrom: "2026-02-01" }), call());
    assert.equal(omitted.status, 400);
    assert.match(((await omitted.json()) as { error: string }).error, /Standard/);
    // Percent of labor has no routing basis and refuses by name.
    const percent = await POST(postRequest({
      method: "standard", rateKind: "percent", ratePercent: "15", effectiveFrom: "2026-02-01",
    }), call());
    assert.equal(percent.status, 400);
    const percentBody = (await percent.json()) as { error: string };
    assert.match(percentBody.error, /Percent of labor/);
    assert.match(percentBody.error, /Company Settings → Features/);
    // The same refusals fire through the direct command layer (assistant/MCP).
    const actor = directActor(org.orgId, actorId);
    assert.equal((await createSetupRecord(actor, "overhead-rates", {
      method: "live", rateKind: "per_hour", ratePercent: "10", effectiveFrom: "2026-03-01",
    })).status, 400);
    const storedId = ((await standard.json()) as { id: string }).id;
    const repurposed = await updateSetupRecord(actor, "overhead-rates", { id: storedId, rateKind: "percent" });
    assert.equal(repurposed.status, 400);
    assert.match((repurposed.body.error as string), /Percent of labor/);
    // An allowed edit still stores through the same path.
    const repriced = await PATCH(patchRequest({ id: storedId, ratePercent: "13.5" }), call());
    assert.equal(repriced.status, 200);
    assert.equal(Number((await readRate(org.orgId, storedId)).ratePercent), 13.5);
    // Deletes never run the mode gate: preserved history stays manageable.
    const deletable = await POST(postRequest({
      method: "standard", rateKind: "per_unit", ratePercent: "3", effectiveFrom: "2027-01-01",
    }), call());
    assert.equal(deletable.status, 200);
    const deletableId = ((await deletable.json()) as { id: string }).id;
    assert.equal((await DELETE(deleteRequest(deletableId), call())).status, 200);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(org.orgId);
  }
});

test("projects-only preserves existing project behavior byte-for-byte", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Overhead Projects Admin", "admin");
  try {
    authenticate(org.orgId, actorId);
    await setFeatures(org.orgId, { projects: true, manufacturing: false });
    // The historical minimal write stores exactly as before: live default,
    // per-hour default, no category.
    const created = await POST(postRequest({ ratePercent: "12.5", effectiveFrom: "2026-01-01" }), call());
    assert.equal(created.status, 200);
    const minimal = await readRate(org.orgId, ((await created.json()) as { id: string }).id);
    assert.equal(minimal.method, "live");
    assert.equal(minimal.rateKind, "per_hour");
    assert.equal(minimal.category, null);
    // Project cards (percent of labor, live engine, dated category) still store.
    const project = await POST(postRequest({
      category: "Indirect Labour", method: "live", rateKind: "percent", ratePercent: "22", effectiveFrom: "2026-01-01",
    }), call());
    assert.equal(project.status, 200);
    const stored = await readRate(org.orgId, ((await project.json()) as { id: string }).id);
    assert.equal(stored.category, "Indirect Labour");
    assert.equal(stored.method, "live");
    assert.equal(stored.rateKind, "percent");
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(org.orgId);
  }
});

test("both-on serves one card to both consumers without reinterpretation", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Overhead Both Admin", "admin");
  try {
    authenticate(org.orgId, actorId);
    await setFeatures(org.orgId, { projects: true, manufacturing: true, inventory: true });
    const verdict = resolveSetupEntityGate(SETUP_ENTITY_BY_KEY.get("overhead-rates")!, { projects: true, manufacturing: true, inventory: true });
    assert.deepEqual(verdict, { enabled: true, remedy: null });
    const shop = await POST(postRequest({
      category: "Cell overhead", method: "standard", rateKind: "per_machine_hour", ratePercent: "31", effectiveFrom: "2026-01-01",
    }), call());
    assert.equal(shop.status, 200);
    const labor = await POST(postRequest({
      category: "Fringe", method: "live", rateKind: "percent", ratePercent: "18", effectiveFrom: "2026-01-01",
    }), call());
    assert.equal(labor.status, 200);
    const shopId = ((await shop.json()) as { id: string }).id;
    const laborId = ((await labor.json()) as { id: string }).id;
    // Neither row is reinterpreted by the other's consumer being on.
    assert.equal((await readRate(org.orgId, shopId)).rateKind, "per_machine_hour");
    assert.equal((await readRate(org.orgId, laborId)).rateKind, "percent");
    assert.equal(await countRates(org.orgId), 2);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(org.orgId);
  }
});

test("neither-on fails closed with the exact remedy and preserves history", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Overhead Off Admin", "admin");
  try {
    authenticate(org.orgId, actorId);
    await setFeatures(org.orgId, { projects: true, manufacturing: false });
    const created = await POST(postRequest({
      category: "Kept history", method: "standard", rateKind: "per_hour", ratePercent: "9.25", effectiveFrom: "2026-01-01",
    }), call());
    assert.equal(created.status, 200);
    const id = ((await created.json()) as { id: string }).id;
    await setFeatures(org.orgId, { projects: false, manufacturing: false });
    // The real descriptor's verdict is the exact C7a remedy, ending with a period.
    const verdict = resolveSetupEntityGate(SETUP_ENTITY_BY_KEY.get("overhead-rates")!, { projects: false, manufacturing: false, inventory: true });
    assert.deepEqual(verdict, { enabled: false, remedy: SETUP_PROJECTS_OR_MANUFACTURING_REMEDY });
    assert.equal(verdict.remedy, FEATURES_REMEDY);
    const actor = directActor(org.orgId, actorId);
    assert.deepEqual(await preflightSetupWrite(actor, "overhead-rates", "create"), {
      status: 404,
      body: { error: "unknown setup entity" },
    });
    assert.equal((await POST(postRequest({ ratePercent: "1", effectiveFrom: "2026-02-01" }), call())).status, 404);
    assert.equal((await PATCH(patchRequest({ id, ratePercent: "2" }), call())).status, 404);
    assert.equal((await DELETE(deleteRequest(id), call())).status, 404);
    // Toggling preserves the row; re-enabling reads it back unchanged.
    assert.equal(await countRates(org.orgId), 1);
    await setFeatures(org.orgId, { projects: true });
    const kept = await readRate(org.orgId, id);
    assert.equal(kept.category, "Kept history");
    assert.equal(kept.method, "standard");
    assert.equal(Number(kept.ratePercent), 9.25);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(org.orgId);
  }
});

test("manufacturing resolves through inventory, never around it", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Overhead Inventory Admin", "admin");
  try {
    authenticate(org.orgId, actorId);
    await setFeatures(org.orgId, { projects: false, manufacturing: true, inventory: false });
    assert.equal(resolveSetupEntityGate(
      SETUP_ENTITY_BY_KEY.get("overhead-rates")!,
      { projects: false, manufacturing: true, inventory: false },
    ).enabled, false);
    assert.equal((await POST(postRequest({
      method: "standard", rateKind: "per_hour", ratePercent: "5", effectiveFrom: "2026-01-01",
    }), call())).status, 404);
    assert.equal(await countRates(org.orgId), 0);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(org.orgId);
  }
});

test("categories stack, overlaps refuse, and audit stamps the actor", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Overhead Audit Admin", "admin");
  try {
    authenticate(org.orgId, actorId);
    await setFeatures(org.orgId, { projects: true, manufacturing: false });
    const consumables = await POST(postRequest({
      category: "Consumables", method: "live", rateKind: "per_hour", ratePercent: "4", effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30",
    }), call());
    assert.equal(consumables.status, 200);
    // A second category stacks over the same window instead of colliding.
    const indirect = await POST(postRequest({
      category: "Indirect Labour", method: "live", rateKind: "per_hour", ratePercent: "6", effectiveFrom: "2026-01-01",
    }), call());
    assert.equal(indirect.status, 200);
    // The same identity overlapping refuses with the typed overlap code.
    const clash = await POST(postRequest({
      category: "Consumables", method: "live", rateKind: "per_hour", ratePercent: "5", effectiveFrom: "2026-06-01", effectiveTo: "2026-12-31",
    }), call());
    assert.equal(clash.status, 409);
    assert.equal(((await clash.json()) as { code: string }).code, "overlap");
    // Adjacent windows (inclusive bounds, day after close) store cleanly.
    const successor = await POST(postRequest({
      category: "Consumables", method: "live", rateKind: "per_hour", ratePercent: "5", effectiveFrom: "2026-07-01", effectiveTo: "2026-12-31",
    }), call());
    assert.equal(successor.status, 200);
    assert.equal(await countRates(org.orgId), 3);
    // The audit quartet names the writer, on create and on edit.
    const stored = await readRate(org.orgId, ((await consumables.json()) as { id: string }).id);
    assert.equal(stored.createdBy, actorId);
    assert.equal(stored.updatedBy, actorId);
    const patched = await PATCH(patchRequest({ id: String(stored.id), ratePercent: "4.5" }), call());
    assert.equal(patched.status, 200);
    assert.equal((await readRate(org.orgId, String(stored.id))).updatedBy, actorId);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(org.orgId);
  }
});
