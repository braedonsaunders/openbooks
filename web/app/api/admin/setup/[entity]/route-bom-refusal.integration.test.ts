import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Bills of materials change only through PUT /api/inventory/bom (complete
// recipe, expected version, reason, one before/after audit). The generic
// Setup CRUD surface must refuse every mutation verb for `bom-components`
// and name the BOM command, so an admin cannot PATCH one component without a
// revision, DELETE the last component, or store a quantity the build refuses.
const stateKey = Symbol.for("openbooks.bom-generic-refusal-route-test");
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
  const state = globalThis[Symbol.for('openbooks.bom-generic-refusal-route-test')]
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
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
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
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?bom-generic-refusal-route-test";
const { DELETE, PATCH, POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { createSetupRecord, deleteSetupRecord, preflightSetupWrite, updateSetupRecord } = await import(
  "../../../../../lib/setup/write.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

function authenticate(orgId: string, actorId: string) {
  routeState.authz = {
    user: { orgId, id: actorId },
    permissions: new Set(["admin.setup.manage"]),
    allowedSubsidiaryIds: null,
  };
}

const call = (entity: string) => ({ params: Promise.resolve({ entity }) });

async function bomEvidence(orgId: string) {
  const components = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from bom_components where org_id = ${orgId}`)).rows[0]!.n;
  const audits = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and table_name = 'bom_components'`)).rows[0]!.n;
  return { components, audits };
}

test("generic Setup CRUD refuses every bom-components mutation and names the BOM command", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "BOM Refusal Admin", "admin");
    authenticate(org.orgId, actorId);
    const before = await bomEvidence(org.orgId);

    const created = await POST(
      new Request("http://localhost/api/admin/setup/bom-components", {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          assemblyItemId: org.items.assembly,
          componentItemId: org.items.component,
          quantityPer: "0",
          sortOrder: 0,
        }),
      }),
      call("bom-components"),
    );
    assert.equal(created.status, 405);
    assert.match(((await created.json()) as { error: string }).error, /\/api\/inventory\/bom/);

    const updated = await PATCH(
      new Request("http://localhost/api/admin/setup/bom-components", {
        method: "PATCH",
        body: JSON.stringify({ id: randomUUID(), quantityPer: "-3" }),
      }),
      call("bom-components"),
    );
    assert.equal(updated.status, 405);
    assert.match(((await updated.json()) as { error: string }).error, /\/api\/inventory\/bom/);

    const deleted = await DELETE(
      new Request(`http://localhost/api/admin/setup/bom-components?id=${randomUUID()}`, { method: "DELETE" }),
      call("bom-components"),
    );
    assert.equal(deleted.status, 405);
    assert.match(((await deleted.json()) as { error: string }).error, /\/api\/inventory\/bom/);

    // The direct command layer (assistant/MCP tools) shares the refusal.
    const actor = { orgId: org.orgId, id: actorId, permissions: ["admin.setup.manage"] };
    for (const method of ["create", "update", "delete"] as const) {
      const refused = await preflightSetupWrite(actor, "bom-components", method);
      assert.ok(refused, `${method} preflight must refuse`);
      assert.equal(refused.status, 405);
      assert.match((refused.body.error as string), /\/api\/inventory\/bom/);
    }
    assert.equal((await createSetupRecord(actor, "bom-components", {})).status, 405);
    assert.equal((await updateSetupRecord(actor, "bom-components", { id: randomUUID() })).status, 405);
    assert.equal((await deleteSetupRecord(actor, "bom-components", randomUUID())).status, 405);

    assert.deepEqual(await bomEvidence(org.orgId), before, "refused writes store no component and no audit");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
