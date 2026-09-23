import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Bill of materials replacement race (web/app/api/inventory/bom/route.ts).
// ROW EXCLUSIVE table locks do not conflict with each other, so two PUTs on
// an empty BOM used to both read version null and union into a recipe nobody
// wrote. Only the session gate is mocked — the database and the version
// check are real.
const stateKey = Symbol.for("openbooks.bom-route-concurrency-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.bom-route-concurrency-test')]
  export async function guardFeaturePermission(_permission, _featureKey) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "@/lib/feature-gates") {
      return { url: "mock:feature-gates", shortCircuit: true };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?bom-route-concurrency-test";
const { PUT } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

function authenticate(orgId: string, actorId: string) {
  routeState.authz = {
    user: { orgId, id: actorId },
    permissions: new Set(["admin.setup.manage"]),
    allowedSubsidiaryIds: null,
  };
}

function putRequest(body: unknown): Request {
  return new Request("http://localhost/api/inventory/bom", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

function recipe(assemblyItemId: string, componentItemId: string) {
  return {
    assemblyItemId,
    expectedVersion: null,
    reason: "Concurrency regression probe: replace the whole recipe.",
    components: [{ componentItemId, quantityPer: "1" }],
  };
}

async function bomRows(orgId: string, assemblyItemId: string) {
  return (await db.execute<{ componentItemId: string; quantityPer: string }>(sql`
    select component_item_id as "componentItemId", quantity_per::text as "quantityPer"
      from bom_components
     where org_id = ${orgId} and assembly_item_id = ${assemblyItemId}
     order by sort_order, component_item_id`)).rows;
}

async function bomAudits(orgId: string, assemblyItemId: string) {
  return (await db.execute<{ changes: unknown }>(sql`
    select changes from audit_log
     where org_id = ${orgId} and table_name = 'bom_components' and row_id = ${assemblyItemId}
     order by id`)).rows;
}

async function emptyBom(orgId: string, assemblyItemId: string) {
  await db.execute(sql`
    delete from bom_components where org_id = ${orgId} and assembly_item_id = ${assemblyItemId}`);
}

test("two concurrent empty-BOM replacements serialize: one recipe, one 409", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "BOM Race Admin", "admin");
    authenticate(org.orgId, actorId);
    await emptyBom(org.orgId, org.items.assembly);

    const [first, second] = await Promise.all([
      PUT(putRequest(recipe(org.items.assembly, org.items.component))),
      PUT(putRequest(recipe(org.items.assembly, org.items.fifo))),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409], "exactly one writer wins and the loser takes the revision conflict");

    const winner = first.status === 200 ? first : second;
    const winnerComponent = first.status === 200 ? org.items.component : org.items.fifo;
    const body = (await winner.json()) as { version: string; componentCount: number };
    assert.equal(body.componentCount, 1);
    assert.ok(typeof body.version === "string" && body.version.length > 0);

    const rows = await bomRows(org.orgId, org.items.assembly);
    assert.equal(rows.length, 1, "the final recipe is one complete recipe, never the union of both writers");
    assert.equal(rows[0]!.componentItemId, winnerComponent);

    const audits = await bomAudits(org.orgId, org.items.assembly);
    assert.equal(audits.length, 1, "exactly one replacement is audited");
    const changes = audits[0]!.changes as { before: unknown[]; after: { componentItemId: string }[] };
    assert.deepEqual(changes.before, []);
    assert.equal(changes.after.length, 1);
    assert.equal(changes.after[0]!.componentItemId, winnerComponent);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

