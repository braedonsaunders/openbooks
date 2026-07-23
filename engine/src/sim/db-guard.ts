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
 * If the DB name does look disposable (contains sim/test/sandbox/scratch) we note
 * it; if it does not, we proceed but the org-tag guard above is what keeps real
 * data safe.
 */

const NAME_MARKERS = ["sim", "test", "sandbox", "scratch"];
export const SIM_ORG_PREFIX = "SIM · ";

function databaseName(url: string): string {
  const afterSlash = url.split("/").pop() ?? "";
  return afterSlash.split("?")[0]!.toLowerCase();
}

/**
 * True only when the DB is a DEDICATED sim database (name carries a marker).
 * Some engine runners are org-less — they scan EVERY org (e.g. runDunning,
 * runDueRecurringSchedules). Those must never run on a shared cluster, or they
 * would touch real tenants. Gate such ops on this.
 */
export function isDedicatedSimDatabase(): boolean {
  const name = databaseName(env.OPENBOOKS_DB_URL ?? "");
  return NAME_MARKERS.some((m) => name.includes(m));
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

/** Gate every run: OPENBOOKS_SIM must be explicitly set. */
export function assertSimEnabled(): void {
  if (env.OPENBOOKS_SIM !== "1") {
    throw new Error(
      "refusing to run: set OPENBOOKS_SIM=1 to confirm you are running the business " +
        "simulation harness (it provisions orgs and, on reset, wipes them).",
    );
  }
  if (!env.OPENBOOKS_DB_URL) throw new Error("OPENBOOKS_DB_URL is not set");
  const name = databaseName(env.OPENBOOKS_DB_URL);
  if (!NAME_MARKERS.some((m) => name.includes(m))) {
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
  const r = (await db.execute(sql`
    select name, coalesce((settings->>'simHarness')::boolean, false) as tagged
      from orgs where id = ${orgId}`)) as unknown as { rows: { name: string; tagged: boolean }[] };
  const row = r.rows[0];
  if (!row) throw new Error(`org ${orgId} not found`);
  if (!row.tagged) {
    throw new Error(
      `refusing destructive op on org ${orgId} ("${row.name}"): not a sim-tagged org. ` +
        "The harness only ever wipes orgs it created.",
    );
  }
}
