import { sql } from "drizzle-orm";
import type { SqlExecutor } from "./db.ts";

/**
 * Shared legacy-provenance read contract (0326 upgrade_legacy_provenance).
 *
 * Several upgrades backfilled history the old code never recorded
 * (0297 rule versions, 0298 rate pins, 0292 waiver snapshots, 0274 retention
 * actions, 0293 duplicate subjects, 0299 negative counts). Legacy is
 * MEMBERSHIP in upgrade_legacy_provenance — never note text, so notes stay
 * rewordable without breaking reads.
 *
 * The table may be absent when old code runs ahead of the 0326 upgrade; the
 * presence check below keeps those reads from failing, and each caller
 * passes its class fallback for that window (fail closed: suspect until the
 * registry can exonerate). Once 0326 has applied, the fallback is dead code
 * on live databases and stays only for the transitional read path.
 */
export async function isLegacyProvenance(
  exec: SqlExecutor,
  orgId: string,
  tableName: string,
  rowId: string,
  opts?: { fallback?: boolean },
): Promise<boolean> {
  const present = (
    await exec.execute<{ present: boolean }>(sql`
      select to_regclass('public.upgrade_legacy_provenance') is not null as present
    `)
  ).rows[0]?.present;
  if (!present) return opts?.fallback ?? false;
  const hit = (
    await exec.execute<{ one: number }>(sql`
      select 1 as one
        from upgrade_legacy_provenance
       where org_id = ${orgId}
         and table_name = ${tableName}
         and row_id = ${rowId}
       limit 1
    `)
  ).rows[0];
  return !!hit;
}
