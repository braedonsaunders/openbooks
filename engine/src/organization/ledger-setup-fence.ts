import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * Transaction-scoped fence between journal posting and ledger setup changes.
 * Posts take the shared side so independent documents can post concurrently;
 * changes that can reinterpret ledger setup take the exclusive side. Caller
 * and setup route code must acquire this before reading or locking org state.
 */
export async function lockLedgerSetupFence(
  runner: SqlExecutor,
  orgId: string,
  mode: "shared" | "exclusive",
): Promise<void> {
  const key = `openbooks:ledger-setup:${orgId}`;
  if (mode === "shared") {
    await runner.execute(sql`
      select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))
    `);
  } else {
    await runner.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${key}, 0))
    `);
  }
}
