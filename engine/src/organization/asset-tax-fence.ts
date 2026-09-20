import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

/** Share one publication boundary between approved asset lifecycle changes and
 * their tax consumer. Take this BEFORE locking any asset row. The tax reader
 * must not pass its coverage guard and then observe only half of a transfer.
 * Sorted legal entities keep two-way transfers from acquiring opposite locks.
 */
export async function lockAssetTaxLifecycle(
  tx: SqlExecutor,
  orgId: string,
  subsidiaryIds: string[],
): Promise<void> {
  for (const subsidiaryId of [...new Set(subsidiaryIds)].sort()) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`asset-tax-lifecycle:${orgId}:${subsidiaryId}`},0))`,
    );
  }
}
