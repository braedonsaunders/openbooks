import { sql } from "drizzle-orm";
import { DEFAULT_ACCOUNT_GROUPS } from "@openbooks/schema";
import { db } from "../platform/db.ts";

type SqlExecutor = Pick<typeof db, "execute">;

export interface AccountGroupDefaultsReport {
  /**
   * Dimensions where the default catch-all was NOT inserted because the org
   * already resolves unmatched accounts to its own active catch-all (any
   * key). The tenant's group stays authoritative; only genuinely absent
   * defaults are added.
   */
  skippedCatchAllDimensions: string[];
}

/** Storage arbitrated a concurrent catch-all install against this seeder. */
function isCatchAllArbitrationConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (candidate.code === "23505" && candidate.constraint === "account_groups_one_active_catch_all") {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * Insert the product-owned default `cost_pool` and `burden` account groups
 * for one org. INSERT-MISSING ONLY: keyed on (org_id, dimension, key), an
 * existing row is left exactly as the tenant left it — a customized match
 * rule is never reverted and a deactivated group is never reactivated.
 * Tenant edits win; only genuinely absent defaults are added.
 *
 * A default catch-all is additionally never inserted into a dimension that
 * already holds an ACTIVE catch-all under any key: inserting `other`
 * alongside the tenant's own catch-all would silently re-bucket every
 * unmatched account (resolveAccountGroups takes the first catch-all by
 * sort_order), breaking this function's own preserve-operator-policy
 * promise. The skip is reported in the returned dimensions.
 *
 * The `on conflict do nothing` below is that guarantee, not a convenience:
 * the previous standalone seeder refreshed every default in place, so
 * re-running it silently erased operator classification policy with no
 * audit. A genuine "reset to defaults" stays an explicit per-group admin
 * edit through the account-group API (which audits before/after), never a
 * side effect of provisioning.
 */
export async function ensureAccountGroupDefaults(
  orgId: string,
  actorId: string | null = null,
  executor: SqlExecutor = db,
): Promise<AccountGroupDefaultsReport> {
  const authoritative = new Set(
    (
      await executor.execute<{ dimension: string }>(sql`
        select distinct dimension
          from account_groups
         where org_id = ${orgId} and is_catch_all and is_active
      `)
    ).rows.map((row) => row.dimension),
  );
  const skippedCatchAllDimensions: string[] = [];
  for (const group of DEFAULT_ACCOUNT_GROUPS) {
    if (group.isCatchAll && authoritative.has(group.dimension)) {
      skippedCatchAllDimensions.push(group.dimension);
      continue;
    }
    try {
      await executor.execute(sql`
        insert into account_groups (
          org_id, dimension, key, name, color, sort_order, match, is_catch_all,
          created_by, updated_by
        )
        values (
          ${orgId}, ${group.dimension}, ${group.key}, ${group.name}, ${group.color},
          ${group.sortOrder}, ${JSON.stringify(group.match)}::jsonb, ${group.isCatchAll},
          ${actorId}, ${actorId}
        )
        on conflict (org_id, dimension, key) do nothing
      `);
    } catch (error) {
      // A concurrent writer installed its own catch-all after the check
      // above; storage (0319 partial unique index) arbitrated and the
      // tenant's group won, so the default stays out the same as if the
      // check had seen it. Anything else rethrows.
      if (group.isCatchAll && isCatchAllArbitrationConflict(error)) {
        skippedCatchAllDimensions.push(group.dimension);
        continue;
      }
      throw error;
    }
  }
  return { skippedCatchAllDimensions };
}
