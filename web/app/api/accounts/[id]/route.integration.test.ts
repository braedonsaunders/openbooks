import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { Client } from "pg";

// Live-Postgres regression for fnd_mt97h8qg_bj7svd: the account PATCH route
// used to walk descendants for a cycle BEFORE opening its transaction and
// OCC-guard only the edited row, so two concurrent reciprocal reparents
// (A.parent=B beside B.parent=A) each saw a clean tree on different rows and
// BOTH committed a two-node cycle. The route now serializes every parent edit
// per org behind a transaction-scoped advisory lock and re-walks ancestors
// INSIDE the transaction, so the loser decides against the winner's committed
// edge and rolls back. These tests drive the REAL route handler from two
// interleaved sessions: a holder pins `accounts` in SHARE mode (SELECTs pass,
// UPDATEs park) so both requests provably finish their pre-transaction reads
// before either can commit, then releases and the serialized loser must
// refuse. A control proves two independent valid reparents still both commit.

const stateKey = Symbol.for("openbooks.account-route-test");
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
  const state = globalThis[Symbol.for('openbooks.account-route-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export async function getAuthz() {
    return state.authz
  }
  export function can(_authz, permission) {
    return state.authz?.permissions?.has(permission) ?? false
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The server-only marker gates RSC bundling; shim it so server modules
    // load under the plain runner (same seam as the IR recipient route test).
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    // The route imports authz by relative path; stub it at that exact
    // specifier so no real session machinery loads.
    if (specifier === "../../../../lib/authz") {
      return { url: "mock:authz", shortCircuit: true };
    }
    // Forward Next.js-style aliases to the real modules they point at.
    if (specifier.startsWith("@/") && context.parentURL) {
      const parentDir = decodeURIComponent(new URL(".", context.parentURL).href);
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts").href, context);
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

const routeUrl = "./route.ts?account-hierarchy-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/test-fixtures.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Seed one summary account of a single shared type; returns its id. */
async function seedSummaryAccount(orgId: string, number: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active,
                          eliminate, reconcilable, required_dimensions, custom,
                          subsidiary_include_children)
    values (${id}, ${orgId}, ${number}, ${`Summary ${number}`}, 'asset_other', true, true,
            false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  return id;
}

function patchRequest(body: unknown): Request {
  return new Request("http://localhost/api/accounts/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function parentIdOf(orgId: string, accountId: string): Promise<string | null> {
  const r = await db.execute<{ parent_id: string | null }>(sql`
    select parent_id from accounts where org_id = ${orgId} and id = ${accountId}`);
  assert.ok(r.rows[0], "the edited account must still exist");
  return r.rows[0]!.parent_id;
}

/** Number of accounts that are their own ancestor — nonzero means a cycle exists. */
async function selfAncestorCount(orgId: string): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`
    with recursive anc as (
      select id, parent_id as anc_id from accounts where org_id = ${orgId}
      union
      select a.id, p.parent_id from anc a
      join accounts p on p.id = a.anc_id
      where p.parent_id is not null
    )
    select count(*)::int as n from anc where id = anc_id`);
  return r.rows[0]!.n;
}

async function auditCount(orgId: string, rowIds: string[]): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and table_name = 'accounts' and row_id in ${rowIds}`);
  return r.rows[0]!.n;
}

/**
 * Deterministic barrier: hold SHARE on accounts so both in-flight PATCHes can
 * finish every pre-transaction read while NEITHER may commit, and wait until
 * one of them has parked inside its transaction on the hierarchy advisory
 * lock (its winner holds it pre-commit). Only then release the table: the
 * first committer's edge is already durable before the loser re-walks.
 */
async function holdAccountsShareLock(orgId: string): Promise<Client> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.OPENBOOKS_DB_URL });
  await client.connect();
  await client.query("begin");
  await client.query(
    "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'on', true)",
    [orgId],
  );
  await client.query("lock table accounts in share mode");
  return client;
}

async function waitForAdvisoryParking(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const r = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and wait_event_type = 'Lock'
         and wait_event = 'advisory'`);
    if ((r.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    "no request ever parked on the hierarchy advisory lock — parent edits are not serialized in-transaction",
  );
}

test("concurrent reciprocal reparents commit at most one edge and refuse the cycle", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  let holder: Client | null = null;
  try {
    const { adminId } = await seedFlowActors(org.orgId);
    routeState.authz = { user: { orgId: org.orgId, id: adminId }, permissions: new Set(), allowedSubsidiaryIds: null };
    const a = await seedSummaryAccount(org.orgId, "9101");
    const b = await seedSummaryAccount(org.orgId, "9102");

    holder = await holdAccountsShareLock(org.orgId);
    const results = await Promise.all([
      PATCH(patchRequest({ parentId: b }), { params: Promise.resolve({ id: a }) }).then(async (res) => ({
        status: res.status,
        body: (await res.json()) as { error?: string; field?: string },
      })),
      PATCH(patchRequest({ parentId: a }), { params: Promise.resolve({ id: b }) }).then(async (res) => ({
        status: res.status,
        body: (await res.json()) as { error?: string; field?: string },
      })),
      // Park both requests mid-flight: each has passed its reads while the
      // table is frozen against writes, and the loser is queued behind the
      // winner's transaction-scoped hierarchy lock.
      waitForAdvisoryParking(),
    ]);
    const [first, second] = results;

    await holder.query("commit");
    await holder.end();
    holder = null;

    const statuses = [first.status, second.status].sort((x, y) => x - y);
    assert.deepEqual(statuses, [200, 422], "at most one cross-reparent may commit");
    const refused = first.status === 422 ? first : second;
    assert.equal(refused.body.error, "parent_cycle");
    assert.equal(refused.body.field, "parentId");

    // Exactly one hierarchy edge survived, pointing one way only.
    const aParent = await parentIdOf(org.orgId, a);
    const bParent = await parentIdOf(org.orgId, b);
    const edges = [aParent, bParent].filter(Boolean);
    assert.equal(edges.length, 1, "exactly one reciprocal edge committed");
    if (aParent) assert.equal(aParent, b, "the surviving edge must be one of the requested parents");
    else assert.equal(bParent, a, "the surviving edge must be one of the requested parents");
    assert.equal(await selfAncestorCount(org.orgId), 0, "the chart must remain acyclic");

    // The refused write left zero trace: exactly one atomic update audit.
    assert.equal(await auditCount(org.orgId, [a, b]), 1);
  } finally {
    routeState.authz = null;
    if (holder) {
      await holder.query("rollback").catch(() => {});
      await holder.end().catch(() => {});
    }
  }
});

test("concurrent valid reparents serialize on the hierarchy lock and both commit", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { adminId } = await seedFlowActors(org.orgId);
    routeState.authz = { user: { orgId: org.orgId, id: adminId }, permissions: new Set(), allowedSubsidiaryIds: null };
    const m1 = await seedSummaryAccount(org.orgId, "9201");
    const m2 = await seedSummaryAccount(org.orgId, "9202");
    const p1 = await seedSummaryAccount(org.orgId, "9203");
    const p2 = await seedSummaryAccount(org.orgId, "9204");

    const responses = await Promise.all([
      PATCH(patchRequest({ parentId: p1 }), { params: Promise.resolve({ id: m1 }) }),
      PATCH(patchRequest({ parentId: p2 }), { params: Promise.resolve({ id: m2 }) }),
    ]);
    assert.deepEqual(responses.map((r) => r.status), [200, 200]);
    assert.equal(await parentIdOf(org.orgId, m1), p1);
    assert.equal(await parentIdOf(org.orgId, m2), p2);
    assert.equal(await selfAncestorCount(org.orgId), 0);

    // Each committed move carries its own atomic before/after audit row.
    assert.equal(await auditCount(org.orgId, [m1, m2]), 2);
  } finally {
    routeState.authz = null;
  }
});
