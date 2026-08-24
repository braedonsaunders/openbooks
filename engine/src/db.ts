import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@openbooks/schema";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  // Local dev reads the repo-root .env; containers have no .env file and
  // provide everything through the process environment instead.
  try {
    for (const line of readFileSync(join(repoRoot, ".env"), "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]!] = m[2]!;
    }
  } catch {
    // no .env — container/CI environment
  }
  // Process env wins over the file so a deploy can override single values.
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && /^[A-Z0-9_]+$/.test(k)) env[k] = v;
  }
  // Mirror the resolved env back into process.env so modules that read
  // process.env directly (e.g. @openbooks/jobs → OPENBOOKS_REDIS_URL) see the
  // file-based dev config too. Process env still wins (only fills gaps).
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return env;
}

export const env = loadEnv();

const databaseUrl =
  env.OPENBOOKS_BOOTSTRAP === "1"
    ? env.OPENBOOKS_MIGRATION_DB_URL || env.OPENBOOKS_DB_URL
    : env.OPENBOOKS_DB_URL;

const basePool = new pg.Pool({
  connectionString: databaseUrl,
  max: 10,
  keepAlive: true,
  // Without a client-side read timeout, a query in flight during an intermittent
  // network interruption can hang on a half-open socket for the OS TCP
  // timeout (many minutes), wedging long-running jobs. query_timeout aborts the
  // query client-side and destroys the poisoned connection; the pool reconnects
  // on the next query and callers' try/catch see a normal rejection (safe to
  // retry / re-run). statement_timeout is the server-side backstop.
  connectionTimeoutMillis: 30_000,
  query_timeout: 120_000,
  statement_timeout: 120_000,
});
// A transient network interruption can make
// an idle pool client emit 'error'; with no listener, Node crashes the whole
// process — fatal for long-running jobs. Swallow it: the pool reconnects on the
// next query, and per-query failures still reject normally (callers catch them).
basePool.on("error", (err) => {
  console.error("[pg pool] transient client error (ignored, will reconnect):", (err as Error).message);
});

// A separate pool for long-running, org-spanning units of work (the sandbox
// clone engine, refresh, and org wipes) run via withOrg. These single
// transactions can far exceed the request pool's 120s client query_timeout —
// e.g. deleting a large ledger fires per-row kernel triggers — so this pool
// disables the client- and server-side statement timeouts. Small, since only a
// couple of clone/wipe jobs run at once (the worker serializes them).
const longPool = new pg.Pool({
  connectionString: databaseUrl,
  max: 4,
  keepAlive: true,
  connectionTimeoutMillis: 30_000,
  query_timeout: 0,
  statement_timeout: 0,
});
longPool.on("error", (err) => {
  console.error("[pg longPool] transient client error (ignored, will reconnect):", (err as Error).message);
});

/**
 * `pg.Pool` handles errors emitted by idle clients, but a checked-out client is
 * the caller's responsibility. A tunnel or database failover can therefore
 * emit an `error` between awaited queries and terminate Node even though the
 * surrounding operation is prepared to retry. Keep one listener for the whole
 * checkout, remember that the session is poisoned, and make release discard it.
 */
function protectCheckedOutClient(client: pg.PoolClient, label: string): pg.PoolClient {
  let connectionError: Error | undefined;
  let released = false;
  const originalRelease = client.release.bind(client);
  const handleError = (error: Error) => {
    connectionError = error;
    console.error(`[${label}] checked-out client error; discarding connection:`, error.message);
  };
  client.on("error", handleError);
  client.release = ((error?: Error | boolean) => {
    if (released) return;
    released = true;
    client.off("error", handleError);
    originalRelease(error || connectionError);
  }) as pg.PoolClient["release"];
  return client;
}

const rawLongConnect = async (): Promise<pg.PoolClient> =>
  protectCheckedOutClient(await longPool.connect(), "pg longPool");

/** Timeout-free pool for long org-scoped units of work (backups, clones). */
export { longPool };

// ---------------------------------------------------------------------------
// Tenant isolation via Postgres RLS.
//
// Every row-level-secured table's policy keys off two GUCs: `app.current_org`
// (the tenant) and `app.bypass_rls` (trusted server-side code that must span
// orgs — the clone engine, seeds, migrations). The policy DENIES by default:
// with no org set and bypass off, business tables return zero rows.
//
// The GUCs are applied per checked-out connection from an AsyncLocalStorage
// context (withOrg/withBypass) or, when none is active, from a host-registered
// per-request resolver (see registerRequestOrgResolver). Code that runs with
// NEITHER is denied by default: it receives an empty organization and bypass
// remains off. Org-spanning work must therefore cross an explicit withBypass or
// withBypassContext boundary; absence of application context is never treated
// as authority.
// ---------------------------------------------------------------------------
type OrgCtx = {
  orgId: string | null;
  bypass: boolean;
  txDb?: NodePgDatabase;
};
type DbRuntime = typeof globalThis & {
  __openbooksOrgContext?: AsyncLocalStorage<OrgCtx>;
  __openbooksRequestOrgResolver?: RequestOrgResolver | null;
};
const dbRuntime = globalThis as DbRuntime;

// Next/Turbopack may instantiate this file through both a workspace alias and
// a relative engine import. Tenant scope must span those module graphs: a
// module-local AsyncLocalStorage would make the second graph silently fall
// back to trusted bypass mode. The process-global singleton preserves the
// request/transaction context across every import identity and hot reload.
export const orgContext = dbRuntime.__openbooksOrgContext ??= new AsyncLocalStorage<OrgCtx>();

// A Next.js request can't scope itself from the inside: calling
// AsyncLocalStorage.enterWith() within an awaited helper (currentUser) does not
// propagate to the caller's async context, so the caller's queries would still
// see no store and fall back to bypass. Instead the web layer registers a
// resolver backed by its own per-request storage (Next's request store); it is
// consulted whenever no explicit orgContext block is active. Explicit
// withOrg/withBypass blocks take precedence over the request default.
export type RequestOrgResolver = () => { orgId: string | null; bypass: boolean } | undefined;
export function registerRequestOrgResolver(fn: RequestOrgResolver): void {
  dbRuntime.__openbooksRequestOrgResolver = fn;
}
function activeOrgCtx(): OrgCtx | undefined {
  return orgContext.getStore() ?? dbRuntime.__openbooksRequestOrgResolver?.();
}

const rawConnect = async (): Promise<pg.PoolClient> =>
  protectCheckedOutClient(
    await (pg.Pool.prototype.connect as (...a: unknown[]) => Promise<pg.PoolClient>).call(basePool),
    "pg pool",
  );

/** Set the RLS GUCs on a client from the active context (deny if none). */
async function applyGuc(client: pg.PoolClient, ctx: OrgCtx | undefined): Promise<void> {
  const bypass = ctx?.bypass === true;
  const org = bypass ? "" : ctx?.orgId ?? "";
  await client.query(
    "select set_config('app.current_org', $1, false), set_config('app.bypass_rls', $2, false)",
    [org, bypass ? "on" : "off"],
  );
}

// Wrap the pool so drizzle's `db.execute` and `db.transaction` transparently
// carry the RLS GUCs. Each pooled query brackets applyGuc + the query on one
// dedicated client; each pooled connect (used by drizzle transactions) applies
// the GUCs up front.
(basePool).query = async (text: any, params?: any): Promise<any> => {
  const ctx = activeOrgCtx();
  const client = await rawConnect();
  try {
    await applyGuc(client, ctx);
    return await client.query(text, params);
  } finally {
    client.release();
  }
};
const origConnectDescriptor = pg.Pool.prototype.connect;
(basePool).connect = async (cb?: unknown): Promise<any> => {
  const client = await rawConnect();
  await applyGuc(client, activeOrgCtx());
  if (typeof cb === "function") {
    cb(null, client, client.release.bind(client));
    return;
  }
  return client;
};
void origConnectDescriptor;

export const pool = basePool;
const poolDb = drizzle({ client: basePool });

/**
 * Fail closed when a production process is connected with a role capable of
 * bypassing tenant RLS or escalating itself. FORCE ROW LEVEL SECURITY cannot
 * protect a session whose login is SUPERUSER or BYPASSRLS.
 */
export async function assertSafeRuntimeDatabaseRole(): Promise<void> {
  if (env.NODE_ENV !== "production") return;
  const result = await pool.query<{
    current_user: string;
    unsafe_roles: string[];
  }>(`
    select current_user,
           array(
             select role_row.rolname
               from pg_roles role_row
              where pg_has_role(current_user, role_row.oid, 'MEMBER')
                and (
                  role_row.rolsuper
                  or role_row.rolbypassrls
                  or role_row.rolcreatedb
                  or role_row.rolcreaterole
                  or role_row.rolreplication
                  or role_row.rolname in (
                    'pg_read_server_files',
                    'pg_write_server_files',
                    'pg_execute_server_program'
                  )
                )
              order by role_row.rolname
           )::text[] as unsafe_roles
  `);
  const row = result.rows[0];
  const unsafeRoles = Array.isArray(row?.unsafe_roles)
    ? row.unsafe_roles
    : String(row?.unsafe_roles ?? "")
        .replace(/^\{|\}$/g, "")
        .split(",")
        .filter(Boolean);
  if (!row || unsafeRoles.length > 0) {
    throw new Error(
      `[database-security] refusing production startup: role ${row?.current_user ?? "unknown"} can assume unsafe database privileges (${unsafeRoles.join(", ") || "posture unavailable"})`,
    );
  }
  console.log(
    `[database-security] runtime role ${row.current_user} verified: tenant RLS cannot be bypassed by role privilege`,
  );
}

/**
 * Run `fn` with every `db` query scoped to `orgId` at the database (RLS). Used
 * for multi-statement atomic units (the clone engine, refresh, change-set
 * apply): pins ONE connection and one transaction with the GUCs set LOCAL, so
 * every statement shares the connection (required for `set constraints all
 * deferred` + batched inserts) and the GUCs auto-reset on commit/rollback.
 * Pass `null` to run with bypass — trusted code that must span orgs.
 */
export async function withOrg<T>(orgId: string | null, fn: () => Promise<T>): Promise<T> {
  const active = orgContext.getStore();
  if (active?.txDb && !active.bypass) {
    if (orgId !== active.orgId) {
      throw new Error("cannot change organization inside an active tenant transaction");
    }
    // Reuse the pinned transaction. Opening a second transaction here would
    // hide the caller's uncommitted aggregate writes and break atomicity.
    return fn();
  }
  // Long-running, timeout-free pool — a clone/wipe is one big transaction.
  const client = await rawLongConnect();
  const bypass = orgId === null;
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', $2, true)",
      [bypass ? "" : orgId, bypass ? "on" : "off"],
    );
    const txDb = drizzle({ client });
    // runInOrgContext, not orgContext.run: the scope must outlive the
    // callback's lazy work, or it lands on a pooled connection with the
    // deny-by-default GUCs and this transaction commits having read nothing.
    const result = await runInOrgContext({ orgId, bypass, txDb }, fn);
    await client.query("commit");
    return result;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // connection already broken; release will discard it
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run a normal request-sized unit of work in one tenant-scoped transaction.
 *
 * `withOrg` intentionally uses the timeout-free long-running pool for backups,
 * clones, and destructive maintenance. Interactive application commands need
 * the opposite contract: the regular pool's connection/query/statement
 * timeouts, one pinned connection, and transaction-local RLS settings. This
 * helper is the authoritative boundary for API/MCP idempotency and other
 * multi-step financial commands.
 */
export async function withOrgTransaction<T>(
  orgId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const active = orgContext.getStore();
  if (active?.txDb && !active.bypass) {
    if (orgId !== active.orgId) {
      throw new Error("cannot change organization inside an active tenant transaction");
    }
    return fn();
  }

  const client = await rawConnect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)",
      [orgId],
    );
    const txDb = drizzle({ client });
    const result = await runInOrgContext({ orgId, bypass: false, txDb }, fn);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // A broken connection is discarded by pg when released.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Trusted, org-spanning bypass block (seeds, cross-org maintenance). */
export function withBypass<T>(fn: () => Promise<T>): Promise<T> {
  return withOrg(null, fn);
}

/**
 * Context-only bypass — no pinned connection or transaction, just an
 * AsyncLocalStorage scope forcing bypass for `fn`'s queries. For the identity
 * bootstrap (session cookie → users row), which must read across orgs even
 * when the surrounding request is already scoped to a tenant (the login's
 * home users row can live in a different org than the active sandbox).
 * Use withBypass when the work needs one atomic transaction.
 */
export function withBypassContext<T>(fn: () => Promise<T>): Promise<T> {
  return runInOrgContext({ orgId: null, bypass: true }, fn);
}

/**
 * Apply tenant RLS to independent pooled queries without opening one long
 * transaction. Use this for network-bound jobs (for example model tool loops)
 * whose individual reads must be scoped but must not pin an idle transaction.
 */
export function withOrgContext<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runInOrgContext({ orgId, bypass: false }, fn);
}

/**
 * Enter an AsyncLocalStorage tenant scope and hold it until the callback's work
 * has actually COMPLETED — not merely until the callback has returned.
 *
 * The distinction is not academic; getting it wrong is why context-only scopes
 * silently read an empty database. A drizzle query builder (`db.execute(...)`,
 * and the query helpers built on it) is a LAZY THENABLE: constructing it
 * touches nothing, and the pool is only reached when something awaits it, in
 * the microtask that calls its `.then`. With the natural call shape
 *
 *     withBypassContext(() => db.execute(sql`select ... from orgs`))
 *
 * `orgContext.run` would return that un-started thenable, and the CALLER's
 * `await` would then schedule `.then` outside the scope. The pooled-query
 * wrapper reads `activeOrgCtx()` at execution time, sees no store, and applies
 * the deny-by-default GUCs — so the caller gets ZERO ROWS AND NO ERROR while
 * believing it holds bypass. Every tenant-spanning verification written that
 * way passes vacuously.
 *
 * Awaiting inside the scope schedules that microtask from within it, so the
 * GUCs are applied from the context the caller actually asked for. Callbacks
 * that are plain `async` functions were never affected (their bodies start
 * synchronously); this makes the two shapes behave identically, which is the
 * only defensible contract.
 */
async function runInOrgContext<T>(ctx: OrgCtx, fn: () => Promise<T>): Promise<T> {
  return await orgContext.run(ctx, async () => await fn());
}

/**
 * The app-wide database handle. Inside a `withOrg` block it routes to the pinned
 * transaction connection; otherwise to the pool (which carries the RLS GUCs from
 * the active AsyncLocalStorage context on every query).
 */
export const db = new Proxy(poolDb, {
  get(target, prop, receiver) {
    const current = orgContext.getStore()?.txDb;
    // `withOrg` pins a client and opens the authoritative transaction itself.
    // Calling drizzle's database.transaction() on that same client would emit a
    // second BEGIN/COMMIT, prematurely commit the outer unit, and clear its
    // SET LOCAL tenant scope. Treat nested transaction helpers as participation
    // in the existing atomic unit; any thrown error reaches the outer rollback.
    if (prop === "transaction" && current) {
      return async (fn: (tx: typeof current) => Promise<unknown>) => fn(current);
    }
    const active = current ?? target;
    const value = Reflect.get(active as object, prop, receiver);
    return typeof value === "function" ? value.bind(active) : value;
  },
}) as typeof poolDb;

type DbTransaction = Parameters<Parameters<typeof poolDb.transaction>[0]>[0];

/**
 * Anything a raw statement can run on: the pooled `db`, a transaction handed
 * out by `db.transaction`, or the transaction `withOrg` pins.
 *
 * Helpers that work either inside or outside a transaction used to declare this
 * inline as `{ execute: (query: any) => Promise<unknown> }` — a dozen separate
 * copies, each of which threw the row type away and made every caller assert it
 * back with `as unknown as { rows: … }`. Borrowing drizzle's own signature keeps
 * the row generic intact, so `executor.execute<Row>(sql`…`)` is typed end to end.
 */
export type SqlExecutor = { execute: typeof poolDb.execute };

/**
 * Run one database transaction, reusing the transaction pinned by `withOrg`
 * when the caller already owns the atomic boundary. This prevents nested
 * helpers from issuing a second BEGIN/COMMIT on the same PostgreSQL client and
 * accidentally committing only part of a larger accounting operation.
 */
export async function inDbTransaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  const current = orgContext.getStore()?.txDb;
  if (current) return fn(current as unknown as DbTransaction);
  return db.transaction(fn);
}

export { schema };
