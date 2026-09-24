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

/** Lock every subsidiary currently carrying an asset in a category, then
 * rescan under those locks so a newly attached subsidiary is fenced too. */
export async function lockAssetCategoryTaxLifecycle(
  tx: SqlExecutor,
  orgId: string,
  categoryId: string,
): Promise<string[]> {
  const locked = new Set<string>();
  while (true) {
    const scopes = (await tx.execute<{ subsidiary_id: string }>(sql`
      select distinct subsidiary_id
        from fixed_assets
       where org_id = ${orgId} and category_id = ${categoryId}
       order by subsidiary_id
    `)).rows.map((row) => row.subsidiary_id);
    const missing = scopes.filter((id) => !locked.has(id));
    if (missing.length === 0) return [...locked].sort();
    await lockAssetTaxLifecycle(tx, orgId, missing);
    for (const subsidiaryId of missing) locked.add(subsidiaryId);
  }
}
