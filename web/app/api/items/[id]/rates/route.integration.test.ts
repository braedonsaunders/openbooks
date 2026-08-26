import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression for the rate-book currency race: the first-version
// save must serialize with rate-book currency edits through the same
// advisory fence and row lock the Setup writer takes. Two real sessions —
// the route's own transaction and a paused Setup-shaped PATCH — prove that a
// concurrent currency change cannot pass rate_book_currency_guard while
// first-version creation is in flight.
const stateKey = Symbol.for("openbooks.rates-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.rates-route-test')]
  export async function guardFeaturePermission(_permission, _featureKey) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The server-only marker gates RSC bundling; shim it so server modules
    // load under the plain runner (same seam as the labor-rate-cards test).
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    // Forward Next.js-style aliases to the real modules they point at. The
    // route lives one level deeper than the labor-rate-cards exemplar, so
    // the alias climbs five directories to the web root.
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
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

const routeUrl = "./route.ts?rates-currency-serialization-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, pool } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);
type PoolClient = import("pg").PoolClient;

/** Drizzle wraps driver errors, so match the whole rendered chain. */
function errorChain(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  return `${String(error)}\n${cause === undefined ? "" : String(cause)}`;
}

interface Fixture {
  orgId: string;
  actorId: string;
  itemId: string;
  bookId: string;
}

async function seed(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const bookId = randomUUID();
  await db.execute(sql`
    insert into item_rate_books (org_id, id, code, name, currency, is_default, is_active, created_by, updated_by)
    values (${org.orgId}, ${bookId}, 'FIELD', 'Field Rates', 'CAD', false, true, ${actorId}, ${actorId})`);
  return { orgId: org.orgId, actorId, itemId: org.items.service, bookId };
}

/** The Setup rate-book writer's exact lock shape, paused mid-transaction. */
async function openSetupShapedPatch(
  fixture: Fixture,
  withAdvisory: boolean,
): Promise<{ client: PoolClient; pid: number }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.bypass_rls', 'on', true)");
    if (withAdvisory) {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `item-rate-books:${fixture.orgId}`,
      ]);
    }
    await client.query(
      "select id from item_rate_books where id = $1 and org_id = $2 for update",
      [fixture.bookId, fixture.orgId],
    );
    const backend = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
    return { client, pid: Number(backend.rows[0]!.pid) };
  } catch (error) {
    client.release(error as Error);
    throw error;
  }
}

async function observeWaiter(
  blockerPid: number,
  save: Promise<Response>,
): Promise<{ blocked: boolean; waiterPid?: number }> {
  let resolved = false;
  void save.then(() => {
    resolved = true;
  });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (resolved) return { blocked: false };
    const waiters = await pool.query<{ waiter: number }>(
      "select waiting.pid as waiter from pg_locks waiting where not waiting.granted and $1::int = any(pg_blocking_pids(waiting.pid)) limit 1",
      [blockerPid],
    );
    if (waiters.rows[0]?.waiter) {
      return { blocked: true, waiterPid: Number(waiters.rows[0].waiter) };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out observing the rate-book fence held by backend ${blockerPid}`);
}

function ratesBody(): Record<string, unknown> {
  return {
    effectiveFrom: "2026-07-01",
    baseUnit: "hour",
    pricingPolicy: "capped_ladder",
    invoicePresentation: "rate_components",
    tiers: [{ unitCode: "hour", unitName: "Hour", baseQuantity: "1", costRate: "75", billRate: "125" }],
  };
}

function post(fixture: Fixture, body?: Record<string, unknown>): Promise<Response> {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    permissions: new Set(["*"]),
  };
  const payload = { ...ratesBody(), ...body, rateBookId: fixture.bookId };
  return POST(new Request(`http://openbooks.test/api/items/${fixture.itemId}/rates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }), { params: Promise.resolve({ id: fixture.itemId }) });
}

async function assertFirstVersionLanded(fixture: Fixture): Promise<void> {
  const state = (await db.execute<{ versions: number; lines: number; audit: number; currency: string }>(sql`
    select
      (select count(*)::int from item_rate_versions where org_id = ${fixture.orgId} and rate_book_id = ${fixture.bookId}) as versions,
      (select count(*)::int from item_rate_lines l join item_rate_versions v on v.id = l.version_id
        where l.org_id = ${fixture.orgId} and v.rate_book_id = ${fixture.bookId}) as lines,
      (select count(*)::int from audit_log where org_id = ${fixture.orgId} and table_name = 'item_rate_versions') as audit,
      (select currency from item_rate_books where id = ${fixture.bookId}) as currency`));
  assert.equal(state.rows[0]?.versions, 1, "the first version must exist");
  assert.equal(state.rows[0]?.lines, 1, "the version's rate line must exist");
  assert.equal(state.rows[0]?.audit, 1, "the version's audit row must exist");
}

test(
  "first version creation waits on the Setup rate-book fence, so a racing currency PATCH cannot pass the history check",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fixture = await seed();
    const patch = await openSetupShapedPatch(fixture, true);
    let open = true;
    try {
      const save = post(fixture);
      const observed = await observeWaiter(patch.pid, save);
      assert.equal(
        observed.blocked,
        true,
        "first version creation must wait while the Setup-shaped currency PATCH holds the fence",
      );

      // The paused PATCH is the only writer: its guard check sees no version
      // history, so its currency change commits while the save waits.
      await patch.client.query(
        "update item_rate_books set currency = $1 where org_id = $2 and id = $3",
        ["USD", fixture.orgId, fixture.bookId],
      );
      await patch.client.query("commit");
      open = false;

      const response = await save;
      assert.equal(response.status, 200, `save failed: ${JSON.stringify(await response.json())}`);
      await assertFirstVersionLanded(fixture);

      // Exactly one currency generation landed, and the committed first
      // version freezes it: subsequent changes are rejected.
      const book = (await db.execute<{ currency: string }>(sql`
        select currency from item_rate_books where id = ${fixture.bookId}`));
      assert.equal(book.rows[0]?.currency, "USD");
      await assert.rejects(
        db.execute(sql`
          update item_rate_books set currency = 'EUR' where org_id = ${fixture.orgId} and id = ${fixture.bookId}`),
        (error: unknown) =>
          errorChain(error).includes("rate book currency cannot change after version history exists"),
      );
    } finally {
      if (open) await patch.client.query("rollback").catch(() => undefined);
      patch.client.release();
      await dropScratchOrgReporting(fixture.orgId);
    }
  },
);

test(
  "the save holds the advisory fence before it reads the rate book",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fixture = await seed();
    const holder = await openSetupShapedPatch(fixture, false);
    let open = true;
    try {
      const save = post(fixture);
      const observed = await observeWaiter(holder.pid, save);
      assert.equal(
        observed.blocked,
        true,
        "the save must wait on the book row lock before completing",
      );
      // The save is blocked at its book read; by then it must already hold
      // the organization's rate-book advisory fence.
      const fence = await pool.query<{ n: number }>(
        "select count(*)::int as n from pg_locks where locktype = 'advisory' and granted and pid = $1",
        [observed.waiterPid],
      );
      assert.ok(
        (fence.rows[0]?.n ?? 0) >= 1,
        "the advisory fence must be acquired before the book is read",
      );

      await holder.client.query("rollback");
      open = false;
      const response = await save;
      assert.equal(response.status, 200, `save failed: ${JSON.stringify(await response.json())}`);
      await assertFirstVersionLanded(fixture);

      const book = (await db.execute<{ currency: string }>(sql`
        select currency from item_rate_books where id = ${fixture.bookId}`));
      assert.equal(book.rows[0]?.currency, "CAD", "no currency change raced this save");
      await assert.rejects(
        db.execute(sql`
          update item_rate_books set currency = 'USD' where org_id = ${fixture.orgId} and id = ${fixture.bookId}`),
        (error: unknown) =>
          errorChain(error).includes("rate book currency cannot change after version history exists"),
      );
    } finally {
      if (open) await holder.client.query("rollback").catch(() => undefined);
      holder.client.release();
      await dropScratchOrgReporting(fixture.orgId);
    }
  },
);
