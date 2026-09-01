import { sql } from "drizzle-orm";
import { db, env } from "../db.ts";

/**
 * Safety interlocks.
 *
 * The harness runs against whatever OPENBOOKS_DB_URL points at — which, on this
 * deployment, is the SHARED cluster that also backs the dev app (no separate sim
 * database is available: the app role lacks CREATEDB). So isolation is enforced
 * at the ORG level instead of the database level:
 *
 *   1. Nothing runs without OPENBOOKS_SIM=1 (an explicit opt-in).
 *   2. Every org the harness provisions is TAGGED (`settings.simHarness = true`,
 *      name prefixed "SIM · ").
 *   3. Destructive ops (reset/wipe) REFUSE any org that is not sim-tagged — so a
 *      wrong id can never wipe a real tenant.
 *
 * Provisioning additionally requires a loopback host and a disposable
 * database name.  This prevents a production URL from reaching a query even
 * when OPENBOOKS_SIM is accidentally enabled, while preserving the existing
 * remote-dedicated-database behavior for replay/sim callers.
 */

const NAME_MARKERS = ["sim", "test", "sandbox", "scratch"] as const;
export const SIM_ORG_PREFIX = "SIM · ";

type DisposableDatabaseUrl = {
  host: string;
  databaseName: string;
};

function parseDatabaseUrl(url: string): DisposableDatabaseUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("OPENBOOKS_DB_URL is not a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("OPENBOOKS_DB_URL must use the postgres or postgresql scheme");
  }
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch {
    throw new Error("OPENBOOKS_DB_URL contains an invalid database name");
  }
  if (!databaseName || databaseName.includes("/")) {
    throw new Error("OPENBOOKS_DB_URL must include a database name");
  }
  return { host: parsed.hostname.toLowerCase(), databaseName: databaseName.toLowerCase() };
}

// The shared replay/sim guard historically identified dedicated databases by
// substring alone. Keep that permissive behavior for existing callers; the
// strict URL parser above is reserved for provisioning's fail-closed gate.
function legacyDatabaseName(url: string): string {
  const afterSlash = url.split("/").pop() ?? "";
  return afterSlash.split("?")[0]!.toLowerCase();
}

function hasDisposableMarker(databaseName: string): boolean {
  // Keep the established shared-policy contract: callers that already use
  // assertDedicatedSimDatabase accept any database name containing a marker.
  return NAME_MARKERS.some((marker) => databaseName.includes(marker));
}

/**
 * Validate a database URL before any harness query is attempted.  The URL is
 * never included in an error so credentials cannot leak through diagnostics.
 */
export function assertDisposableDatabaseUrl(
  url: string,
  op = "database operation",
  options: { requireLoopback?: boolean } = {},
): DisposableDatabaseUrl {
  const parsed = parseDatabaseUrl(url);
  if (
    options.requireLoopback &&
    parsed.host !== "127.0.0.1" &&
    parsed.host !== "localhost"
  ) {
    throw new Error(
      `refusing "${op}": OPENBOOKS_DB_URL host must be 127.0.0.1 or localhost (got ${parsed.host || "<empty>"})`,
    );
  }
  if (!hasDisposableMarker(parsed.databaseName)) {
    throw new Error(
      `refusing "${op}": database name must contain an approved disposable marker (sim, test, sandbox, or scratch)`,
    );
  }
  return parsed;
}

/**
 * True only when the DB is a DEDICATED sim database (name carries a marker).
 * Some engine runners are org-less — they scan EVERY org (e.g. the global
 * runDunning and runDueRecurringSchedules entry points). Those must never run
 * on a shared cluster, or they would touch real tenants. Tenant-scoped runners
 * such as dunning's runDunningForOrg are safe for the simulator's tagged org.
 * Gate org-less ops on this.
 */
export function isDedicatedSimDatabase(url = env.OPENBOOKS_DB_URL ?? ""): boolean {
  return hasDisposableMarker(legacyDatabaseName(url));
}

export function assertDedicatedSimDatabase(op: string): void {
  if (!isDedicatedSimDatabase()) {
    throw new Error(
      `refusing "${op}": it is an ORG-LESS engine runner that scans every org, so it must only ` +
        `run against a DEDICATED sim database (name containing sim/test/sandbox/scratch). ` +
        `The current DB is shared; skip this op or point OPENBOOKS_DB_URL at an isolated DB.`,
    );
  }
}

/** Strict provisioning gate: disposable databases must be loopback-only. */
export function assertLoopbackDisposableDatabase(op: string): void {
  const url = env.OPENBOOKS_DB_URL;
  if (!url) throw new Error("OPENBOOKS_DB_URL is not set");
  assertDisposableDatabaseUrl(url, op, { requireLoopback: true });
}

/** Gate every run: OPENBOOKS_SIM must be explicitly set. */
export function assertSimEnabled(): void {
  if (env.OPENBOOKS_SIM !== "1") {
    throw new Error(
      "refusing to run: set OPENBOOKS_SIM=1 to confirm you are running the business " +
        "simulation harness (it provisions orgs and, on reset, wipes them).",
    );
  }
  if (!env.OPENBOOKS_DB_URL) throw new Error("OPENBOOKS_DB_URL is not set");
  const name = legacyDatabaseName(env.OPENBOOKS_DB_URL);
  if (!hasDisposableMarker(name)) {
    console.error(
      `[sim] note: database "${name}" is not a dedicated sim database — sim orgs are ` +
        `tagged "${SIM_ORG_PREFIX}…" and isolated by org; destructive ops refuse untagged orgs.`,
    );
  }
}

/**
 * Guard a destructive op: the org must be sim-tagged. Throws otherwise. Runs
 * under the caller's context; assumes bypass/org scope is already established.
 */
export async function assertSimOrg(orgId: string): Promise<void> {
  const r = (await db.execute<{ name: string; tagged: boolean }>(sql`
    select name, coalesce((settings->>'simHarness')::boolean, false) as tagged
      from orgs where id = ${orgId}`));
  const row = r.rows[0];
  if (!row) throw new Error(`org ${orgId} not found`);
  if (!row.tagged) {
    throw new Error(
      `refusing destructive op on org ${orgId} ("${row.name}"): not a sim-tagged org. ` +
        "The harness only ever wipes orgs it created.",
    );
  }
}
