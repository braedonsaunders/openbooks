import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression: POST /api/subcontracts validates money inputs to
// 4dp but never bounds their magnitude, so a pasted 20-digit commitment sails
// through and dies in Postgres as a raw numeric(19,4) overflow. The action
// switch only maps SubcontractError to 422 — the overflow escapes as HTTP 500
// ("Subcontract action failed") instead of failing closed with the named 422
// the junk-input path returns.
const stateKey = Symbol.for("openbooks.subcontract-magnitude-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.subcontract-magnitude-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export function guardSubsidiaryScope() { return null }
`;

const engineRoot = new URL("../../../../engine/", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "next/navigation") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export function redirect() {}" };
    }
    // Bare @openbooks/engine/* resolves cross-checkout to main; pin the
    // engine graph to the worktree copy under test.
    if (specifier.startsWith("@openbooks/engine/")) {
      return nextResolve(new URL(specifier.slice("@openbooks/engine/".length), engineRoot).href, context);
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (
      specifier === "../../../lib/authz" &&
      context.parentURL?.includes("/api/subcontracts/")
    ) {
      return { url: "mock:subcontract-magnitude-authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:subcontract-magnitude-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?subcontract-magnitude-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, env, withBypass, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);

interface Fixture {
  orgId: string;
  actorId: string;
  projectId: string;
  vendorId: string;
}

async function seed(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"projects": true, "subcontracts": true}'::jsonb)
     where id = ${org.orgId}`);
  const projectId = (await db.execute<{ id: string }>(sql`
    insert into projects (org_id, name, is_active)
    values (${org.orgId}, 'Magnitude Project', true)
    returning id`)).rows[0]!.id;
  const vendorId = (await db.execute<{ id: string }>(sql`
    insert into parties (org_id, kind, display_name, is_active)
    values (${org.orgId}, 'company', 'Magnitude Vendor', true)
    returning id`)).rows[0]!.id;
  await db.execute(sql`
    insert into vendor_roles (org_id, party_id, is_active)
    values (${org.orgId}, ${vendorId}, true)`);
  return { orgId: org.orgId, actorId, projectId, vendorId };
}

async function post(fixture: Fixture, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  try {
    const response = await withOrgContext(fixture.orgId, () => POST(
      new Request("http://openbooks.test/api/subcontracts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ));
    return { status: response.status, json: await response.json().catch(() => null) };
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } };
  }
}

async function subcontractCount(orgId: string): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from subcontracts where org_id = ${orgId}`)).rows;
  return rows[0]!.n;
}

function createBody(fixture: Fixture, originalCommitment: string) {
  return {
    action: "createSubcontract",
    projectId: fixture.projectId,
    vendorId: fixture.vendorId,
    number: "SC-001",
    title: "Magnitude Subcontract",
    originalCommitment,
  };
}

test("POST refuses a commitment wider than numeric(19,4) without writing", { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fixture = await withBypass(seed);
  try {
    const result = await post(fixture, createBody(fixture, "99999999999999999999"));
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`);
    assert.equal(await subcontractCount(fixture.orgId), 0);
  } finally {
    await withBypass(() => dropScratchOrg(fixture.orgId));
  }
});

test("POST still creates a subcontract at the column maximum", { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fixture = await withBypass(seed);
  try {
    const result = await post(fixture, createBody(fixture, "999999999999999.9999"));
    assert.equal(result.status, 201, `expected 201, got ${result.status}: ${JSON.stringify(result.json)}`);
    assert.equal(await subcontractCount(fixture.orgId), 1);
  } finally {
    await withBypass(() => dropScratchOrg(fixture.orgId));
  }
});
