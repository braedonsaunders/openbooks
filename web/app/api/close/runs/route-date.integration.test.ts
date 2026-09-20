import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression: POST /api/close/runs passed targetCloseDate to
// startCloseRun raw, so a shape-valid non-day such as February 30 sailed
// through and died in Postgres as a raw DATE failure (HTTP 500 — the verb
// only maps CloseError to 422) instead of failing closed with a named 422 and
// no run row. (The run-start path is idempotent per org/period/book, so the
// refusal must be proven on a fresh run — a resumed run returns 200 without
// touching the date.)
const stateKey = Symbol.for("openbooks.close-run-date-test");
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
  const state = globalThis[Symbol.for('openbooks.close-run-date-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const engineRoot = new URL("../../../../../engine/", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "next/navigation") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export function redirect() {}" };
    }
    // Bare @openbooks/engine/* resolves cross-checkout to main; pin the
    // engine graph to the worktree copy carrying the startCloseRun guard.
    if (specifier.startsWith("@openbooks/engine/")) {
      return nextResolve(new URL(specifier.slice("@openbooks/engine/".length), engineRoot).href, context);
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (
      specifier === "../../../../lib/authz" &&
      context.parentURL?.includes("/api/close/runs/")
    ) {
      return { url: "mock:close-run-date-authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:close-run-date-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?close-run-date-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, env, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

interface Fixture {
  orgId: string;
  actorId: string;
  periodId: string;
  bookId: string;
}

async function seed(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  return { orgId: org.orgId, actorId, periodId: org.periodId, bookId: org.bookId };
}

async function post(fixture: Fixture, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  try {
    const response = await withOrgContext(fixture.orgId, () => POST(
      new Request("http://openbooks.test/api/close/runs", {
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

async function runCount(orgId: string): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from close_runs where org_id = ${orgId}`)).rows;
  return rows[0]!.n;
}

test("POST refuses an impossible target close date without starting a run", { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fixture = await withBypass(seed);
  try {
    const result = await post(fixture, {
      periodId: fixture.periodId, bookId: fixture.bookId, targetCloseDate: "2024-02-30",
    });
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`);
    assert.equal(await runCount(fixture.orgId), 0);
  } finally {
    await withBypass(() => dropScratchOrg(fixture.orgId));
  }
});

test("POST still starts a run with a real target close date", { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fixture = await withBypass(seed);
  try {
    const result = await post(fixture, {
      periodId: fixture.periodId, bookId: fixture.bookId, targetCloseDate: "2024-02-29",
    });
    assert.equal(result.status, 200, `expected 200, got ${result.status}: ${JSON.stringify(result.json)}`);
    assert.equal(await runCount(fixture.orgId), 1);
  } finally {
    await withBypass(() => dropScratchOrg(fixture.orgId));
  }
});
