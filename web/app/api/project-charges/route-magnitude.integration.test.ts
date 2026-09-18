import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression: POST /api/project-charges validates line
// quantities to 8dp and rates to 4dp but never bounds their magnitude, so a
// pasted oversized figure sails through and dies in Postgres as a raw numeric
// overflow (HTTP 500 — the catch only maps ChargeError to 422) instead of
// failing closed with a named 422 and nothing written. Every charge-line
// figure lands in a numeric(19,4) column — rates and amounts directly, and the
// quantity again through base_quantity, the derived amounts, and the rate
// components — so 15 whole digits is the honest bound for all of them.
const stateKey = Symbol.for("openbooks.project-charge-magnitude-test");
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
  const state = globalThis[Symbol.for('openbooks.project-charge-magnitude-test')]
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
    if (specifier === "next/navigation") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export function redirect() {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (
      specifier === "../../../lib/authz" &&
      context.parentURL?.includes("/api/project-charges/")
    ) {
      return { url: "mock:project-charge-magnitude-authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:project-charge-magnitude-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?project-charge-magnitude-test";
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
  itemId: string;
}

async function seed(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"projects": true}'::jsonb)
     where id = ${org.orgId}`);
  const projectId = (await db.execute<{ id: string }>(sql`
    insert into projects (org_id, name, is_active)
    values (${org.orgId}, 'Charge Project', true)
    returning id`)).rows[0]!.id;
  await db.execute(sql`
    update items set expense_account_id = ${org.accounts.cogs}
     where id = ${org.items.service} and org_id = ${org.orgId}`);
  return { orgId: org.orgId, actorId, projectId, itemId: org.items.service };
}

async function post(fixture: Fixture, line: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  try {
    const response = await withOrgContext(fixture.orgId, () => POST(
      new Request("http://openbooks.test/api/project-charges", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: fixture.projectId,
          lines: [{ itemId: fixture.itemId, quantity: "1", ...line }],
        }),
      }),
    ));
    return { status: response.status, json: await response.json().catch(() => null) };
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } };
  }
}

async function chargeCount(orgId: string): Promise<number> {
  const rows = (await withOrgContext(orgId, () => db.execute<{ n: number }>(sql`
    select count(*)::int as n from documents
     where org_id = ${orgId} and kind = 'project_charge'`))).rows;
  return rows[0]!.n;
}

test("POST refuses a bill rate wider than numeric(19,4) without writing", { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fixture = await withBypass(seed);
  try {
    const result = await post(fixture, { billRate: "99999999999999999999" });
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`);
    assert.equal(await chargeCount(fixture.orgId), 0);
  } finally {
    await withBypass(() => dropScratchOrg(fixture.orgId));
  }
});

test("POST refuses a quantity wider than numeric(19,4) without writing", { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fixture = await withBypass(seed);
  try {
    const result = await post(fixture, { quantity: "99999999999999999999" });
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`);
    assert.equal(await chargeCount(fixture.orgId), 0);
  } finally {
    await withBypass(() => dropScratchOrg(fixture.orgId));
  }
});

test("POST still saves column-maximum rate and quantity with identical read-back", { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fixture = await withBypass(seed);
  try {
    const result = await post(fixture, {
      quantity: "999999999999999.9999",
      costRate: "0",
      billRate: "0",
    });
    assert.equal(result.status, 200, `expected 200, got ${result.status}: ${JSON.stringify(result.json)}`);
    const rows = (await withOrgContext(fixture.orgId, () => db.execute<{ quantity: string; bill_rate: string }>(sql`
      select quantity::text as quantity, bill_rate::text as bill_rate
        from document_lines
       where org_id = ${fixture.orgId}`))).rows;
    assert.equal(rows[0]!.quantity, "999999999999999.99990000");
    assert.equal(rows[0]!.bill_rate, "0.0000");
  } finally {
    await withBypass(() => dropScratchOrg(fixture.orgId));
  }
});
