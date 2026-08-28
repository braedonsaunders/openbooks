import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression for the fair-value audit race. PATCH and DELETE
// used to snapshot a row without FOR UPDATE, so two requests queued behind a
// third transaction could both audit the same stale before-state even though
// PostgreSQL serialized their writes. The two-session blocker below makes the
// interleave deterministic: both route transactions reach their write while
// the row is locked, then the lock is released and the committed audit chain
// must follow the write order.
const stateKey = Symbol.for("openbooks.fair-values-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.fair-values-route-test')]
  export async function guardFeaturePermission(_permission, _featureKey) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(
        new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL)
          .href,
        context,
      );
    }
    if (
      specifier === "../../../../../lib/feature-gates" &&
      context.parentURL?.includes("/api/items/")
    ) {
      return { url: "mock:feature-gates", shortCircuit: true };
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

const routeUrl = "./route.ts?fair-values-concurrency-test";
const { PATCH, DELETE } = (await import(
  routeUrl
)) as typeof import("./route.ts");
hooks.deregister();

const { db, pool } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } =
  await import("@openbooks/engine/src/test-fixtures.ts");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

interface Fixture {
  orgId: string;
  actorId: string;
  itemId: string;
  priceId: string;
}

async function seed(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const row = await db.execute<{ id: string }>(sql`
    insert into fair_value_prices
      (org_id, item_id, currency, unit_price, effective_from, is_active, created_by, updated_by)
    values
      (${org.orgId}, ${org.items.service}, 'CAD', '100.0000', '2026-01-01', true, ${actorId}, ${actorId})
    returning id`);
  return {
    orgId: org.orgId,
    actorId,
    itemId: org.items.service,
    priceId: String(row.rows[0]!.id),
  };
}

function authorize(fixture: Fixture): void {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    permissions: new Set(["*"]),
  };
}

function patchRequest(fixture: Fixture, unitPrice: string): Request {
  return new Request(
    `http://openbooks.test/api/items/${fixture.itemId}/fair-values`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: fixture.priceId,
        currency: "CAD",
        unitPrice,
        effectiveFrom: "2026-01-01",
      }),
    },
  );
}

function deleteRequest(fixture: Fixture): Request {
  return new Request(
    `http://openbooks.test/api/items/${fixture.itemId}/fair-values?id=${encodeURIComponent(fixture.priceId)}`,
    { method: "DELETE" },
  );
}

function patch(fixture: Fixture, unitPrice: string): Promise<Response> {
  authorize(fixture);
  return PATCH(patchRequest(fixture, unitPrice), {
    params: Promise.resolve({ id: fixture.itemId }),
  });
}

function remove(fixture: Fixture): Promise<Response> {
  authorize(fixture);
  return DELETE(deleteRequest(fixture), {
    params: Promise.resolve({ id: fixture.itemId }),
  });
}

interface HeldRowLock {
  client: import("pg").PoolClient;
  pid: number;
}

async function holdRowLock(fixture: Fixture): Promise<HeldRowLock> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.bypass_rls', 'on', true)");
    await client.query(
      "select id from fair_value_prices where id = $1 and org_id = $2 for update",
      [fixture.priceId, fixture.orgId],
    );
    const backend = await client.query<{ pid: number }>(
      "select pg_backend_pid() as pid",
    );
    return { client, pid: Number(backend.rows[0]!.pid) };
  } catch (error) {
    client.release(error as Error);
    throw error;
  }
}

/**
 * Wait until a route request is blocked by one of the supplied sessions.
 * PostgreSQL can report a waiter behind the first route transaction rather
 * than directly behind the external holder, so callers pass both PIDs for
 * the second request.
 */
async function waitForBlockedRequest(
  request: Promise<Response>,
  blockerPids: number[],
): Promise<number> {
  let settled = false;
  void request.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (settled) {
      throw new Error(
        "fair-value request completed before reaching the row-lock barrier",
      );
    }
    const waiters = await pool.query<{ waiter: number; blockers: number[] }>(
      `select activity.pid as waiter, pg_blocking_pids(activity.pid) as blockers
         from pg_stat_activity activity
        where activity.pid <> all($1::int[])
          and cardinality(pg_blocking_pids(activity.pid)) > 0`,
      [blockerPids],
    );
    const waiter = waiters.rows.find((row) =>
      row.blockers.some((pid) => blockerPids.includes(Number(pid))),
    );
    if (waiter) return Number(waiter.waiter);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `timed out waiting for fair-value row lock held by ${blockerPids.join(", ")}`,
  );
}

async function auditRows(fixture: Fixture): Promise<
  Array<{
    action: string;
    changes: {
      before?: { unit_price?: string };
      after?: { unit_price?: string };
    };
  }>
> {
  const result = await db.execute<{
    action: string;
    changes: {
      before?: { unit_price?: string };
      after?: { unit_price?: string };
    };
  }>(sql`
    select action, changes
      from audit_log
     where org_id = ${fixture.orgId} and table_name = 'fair_value_prices' and row_id = ${fixture.priceId}
     order by at, id`);
  return result.rows;
}

test(
  "concurrent fair-value PATCHes audit each committed before-state",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    const holder = await holdRowLock(fixture);
    let holderOpen = true;
    let first: Promise<Response> | undefined;
    let second: Promise<Response> | undefined;
    try {
      first = patch(fixture, "110.0000");
      const firstPid = await waitForBlockedRequest(first, [holder.pid]);
      second = patch(fixture, "120.0000");
      await waitForBlockedRequest(second, [holder.pid, firstPid]);

      await holder.client.query("commit");
      holderOpen = false;
      const responses = await Promise.all([first, second]);
      assert.deepEqual(
        responses.map((response) => response.status),
        [200, 200],
        "both serialized edits must complete successfully",
      );

      const audits = await auditRows(fixture);
      assert.equal(
        audits.length,
        2,
        "each committed edit must have one audit row",
      );
      const beforeByAfter = new Map(
        audits.map((audit) => [
          audit.changes.after?.unit_price,
          audit.changes.before?.unit_price,
        ]),
      );
      assert.equal(beforeByAfter.get("110.0000"), "100.0000");
      assert.equal(
        beforeByAfter.get("120.0000"),
        "110.0000",
        "the second audit must snapshot the first committed edit, never its stale pre-race value",
      );
    } finally {
      if (holderOpen)
        await holder.client.query("rollback").catch(() => undefined);
      if (first || second) {
        await Promise.allSettled(
          [first, second].filter((request): request is Promise<Response> =>
            Boolean(request),
          ),
        );
      }
      holder.client.release();
      routeState.authz = null;
      await dropScratchOrgReporting(fixture.orgId);
    }
  },
);

test(
  "a fair-value PATCH racing DELETE audits the deleted row after the edit",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    const holder = await holdRowLock(fixture);
    let holderOpen = true;
    let edit: Promise<Response> | undefined;
    let deletion: Promise<Response> | undefined;
    try {
      edit = patch(fixture, "110.0000");
      const editPid = await waitForBlockedRequest(edit, [holder.pid]);
      deletion = remove(fixture);
      await waitForBlockedRequest(deletion, [holder.pid, editPid]);

      await holder.client.query("commit");
      holderOpen = false;
      const responses = await Promise.all([edit, deletion]);
      assert.deepEqual(
        responses.map((response) => response.status),
        [200, 200],
        "the edit and delete must both complete successfully in serialized order",
      );

      const audits = await auditRows(fixture);
      assert.equal(
        audits.length,
        2,
        "the edit and delete must each be audited",
      );
      const updateAudit = audits.find((audit) => audit.action === "update");
      const deleteAudit = audits.find((audit) => audit.action === "delete");
      assert.equal(updateAudit?.changes.before?.unit_price, "100.0000");
      assert.equal(
        deleteAudit?.changes.before?.unit_price,
        "110.0000",
        "the delete audit must snapshot the committed PATCH result",
      );
    } finally {
      if (holderOpen)
        await holder.client.query("rollback").catch(() => undefined);
      if (edit || deletion) {
        await Promise.allSettled(
          [edit, deletion].filter((request): request is Promise<Response> =>
            Boolean(request),
          ),
        );
      }
      holder.client.release();
      routeState.authz = null;
      await dropScratchOrgReporting(fixture.orgId);
    }
  },
);
